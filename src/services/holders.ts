import fs from "fs/promises";
import path from "path";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  HOLDERS_JSON_PATH,
  MAX_FETCH_HOLDERS,
  MIN_HOLDER_BALANCE_LAMPORTS,
  MIN_HOLDER_TOKEN_AMOUNT,
  REFETCH_ALL,
  TOKENS,
  HOLDER_BALANCE_BATCH_SIZE,
  HOLDER_BALANCE_DELAY_MS,
} from "../config";
import { createConnection, fetchMintWithProgram } from "../utils/solana";
import { sleep } from "../utils/control";

export type HolderRecord = {
  tokenAddress: string;
  holders: string[];
};

export type HolderWithBalance = {
  address: string;
  lamports: number;
};

export type HolderFetchResult = {
  tokenAddress: string;
  holders: HolderWithBalance[];
  eligibleOwners: number;
};

export type HolderRefreshSummary = {
  tokenAddress: string;
  fetched: number;
  eligibleOwners: number;
  totalLamports: number;
  totalSol: number;
  minLamports: number;
  maxLamports: number;
  status: "updated" | "skipped" | "error";
  reason?: string;
};

export type HolderRefreshResult = {
  filePath: string;
  tokensPlanned: string[];
  refreshed: HolderRefreshSummary[];
};

type HolderFileShape = HolderRecord[] | { tokens: HolderRecord[] };

const parseJsonFile = async (filePath: string): Promise<HolderRecord[]> => {
  try {
    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    const parsed = JSON.parse(raw) as HolderFileShape;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray((parsed as any).tokens)) {
      return (parsed as any).tokens;
    }
  } catch {
    // file may not exist yet
  }
  return [];
};

const writeJsonFile = async (filePath: string, data: HolderRecord[]) => {
  await fs.writeFile(path.resolve(filePath), JSON.stringify(data, null, 2));
};

export const fetchTopHoldersRpc = async ({
  tokenAddress,
  limit,
  minTokenAmount,
  minHolderBalanceLamports,
  balanceBatchSize,
  balanceDelayMs,
}: {
  tokenAddress: string;
  limit: number;
  minTokenAmount: number;
  minHolderBalanceLamports: number;
  balanceBatchSize: number;
  balanceDelayMs: number;
}): Promise<HolderFetchResult> => {
  const connection = createConnection();
  const mintPk = new PublicKey(tokenAddress);
  let programId: PublicKey;
  let mint;

  // 1. Determine Program ID and Mint Info
  try {
    const info = await connection.getAccountInfo(mintPk);
    if (info?.owner) {
      programId = info.owner;
      const fetched = await fetchMintWithProgram(connection, mintPk);
      mint = fetched.mint;
    } else {
      // Fallback
      const fetched = await fetchMintWithProgram(connection, mintPk);
      mint = fetched.mint;
      programId = fetched.programId;
    }
  } catch {
    const fetched = await fetchMintWithProgram(connection, mintPk);
    mint = fetched.mint;
    programId = fetched.programId;
  }

  const decimals = mint.decimals ?? 0;
  const minRaw = BigInt(Math.floor(minTokenAmount * Math.pow(10, decimals)));

  // 2. FETCH ALL HOLDERS using getProgramAccounts
  // (This logic now applies to BOTH Token-2022 and Standard SPL Tokens)
  // Warning: This is a heavy call. Ensure your RPC supports it.
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      {
        dataSize: 165, // Filter for standard Token Account size to optimize query
      },
      {
        memcmp: {
          offset: 0, // Mint address is at offset 0 for both Token & Token-2022
          bytes: mintPk.toBase58(),
        },
      },
    ],
  });

  const holderAmounts = new Map<string, bigint>();

  accounts.forEach((acc) => {
    try {
      // Both Token and Token-2022 store Owner at offset 32 and Amount at offset 64
      const owner = new PublicKey(acc.account.data.slice(32, 64));
      const amount = acc.account.data.readBigUInt64LE(64);
      const ownerAddress = owner.toBase58();

      const currentAmount = holderAmounts.get(ownerAddress) ?? 0n;
      holderAmounts.set(ownerAddress, currentAmount + amount);
    } catch {
      // Ignore malformed token accounts
    }
  });

  // 3. Filter and Sort
  const filteredHolders = Array.from(holderAmounts.entries())
    .filter(([, amount]) => amount > 0n && amount >= minRaw)
    .sort(([, amountA], [, amountB]) => (amountA < amountB ? 1 : -1)); // Descending sort

  // 4. Fetch SOL Balances in Batches
  const holderPubkeys = filteredHolders.map(([owner]) => new PublicKey(owner));
  const holdersWithBalance: HolderWithBalance[] = [];

  const batchSize = Math.max(1, balanceBatchSize || 100);

  // Loop through all eligible holders until we hit the 'limit'
  for (let i = 0; i < holderPubkeys.length; i += batchSize) {
    if (holdersWithBalance.length >= limit) break;

    const batch = holderPubkeys.slice(i, i + batchSize);

    // getMultipleAccountsInfo is much faster than individual getBalance calls
    const balances = await connection.getMultipleAccountsInfo(batch);

    if (balanceDelayMs > 0) {
      await sleep(balanceDelayMs);
    }

    for (let j = 0; j < batch.length; j++) {
      if (holdersWithBalance.length >= limit) break;

      const accountInfo = balances[j];
      // Only add if they have the required SOL balance
      if (accountInfo && accountInfo.lamports >= minHolderBalanceLamports) {
        holdersWithBalance.push({
          address: batch[j].toBase58(),
          lamports: accountInfo.lamports,
        });
      }
    }
  }

  return {
    tokenAddress,
    holders: holdersWithBalance,
    eligibleOwners: filteredHolders.length,
  };
};

export const refreshTokenHolders = async ({
  tokens,
  limit = MAX_FETCH_HOLDERS,
  refetchExisting,
  minTokenAmount = MIN_HOLDER_TOKEN_AMOUNT,
  minHolderBalanceLamports = MIN_HOLDER_BALANCE_LAMPORTS,
  balanceBatchSize = HOLDER_BALANCE_BATCH_SIZE,
  balanceDelayMs = HOLDER_BALANCE_DELAY_MS,
  filePath = HOLDERS_JSON_PATH,
}: {
  tokens?: string[];
  limit?: number;
  refetchExisting?: boolean;
  minTokenAmount?: number;
  minHolderBalanceLamports?: number;
  balanceBatchSize?: number;
  balanceDelayMs?: number;
  filePath?: string;
} = {}): Promise<HolderRefreshResult> => {
  const existing = await parseJsonFile(filePath);
  const existingMap = new Map<string, HolderRecord>();
  existing.forEach((r) => existingMap.set(r.tokenAddress, r));

  const tokensFromSettings = TOKENS ?? [];
  const requestedTokens = tokens ?? [];

  const allTokens = Array.from(
    new Set<string>([
      ...existing.map((r) => r.tokenAddress),
      ...tokensFromSettings,
      ...requestedTokens,
    ]).values()
  );

  const shouldRefetch = refetchExisting || REFETCH_ALL;
  const tokensToFetch = allTokens.filter((token) => {
    const current = existingMap.get(token);
    if (
      !current ||
      !Array.isArray(current.holders) ||
      current.holders.length === 0
    ) {
      return true;
    }
    if (requestedTokens.includes(token)) {
      // Only refetch requested tokens when explicitly allowed.
      if (shouldRefetch) return true;
      return false;
    }
    if (shouldRefetch) return true;
    return false;
  });

  const refreshed: HolderRefreshSummary[] = [];

  console.log(
    `[holders] Planned tokens=${tokensToFetch.length} (requested=${requestedTokens.length}, existing=${existing.length}, refetch=${shouldRefetch})`
  );

  for (const token of tokensToFetch) {
    try {
      console.log(`[holders] Fetching ${token}...`);
      const result = await fetchTopHoldersRpc({
        tokenAddress: token,
        limit,
        minTokenAmount,
        minHolderBalanceLamports,
        balanceBatchSize,
        balanceDelayMs,
      });
      const holderAddresses = result.holders.map((h) => h.address);
      existingMap.set(token, { tokenAddress: token, holders: holderAddresses });

      const totalLamports = result.holders.reduce(
        (acc, h) => acc + h.lamports,
        0
      );
      const lamportsValues = result.holders.map((h) => h.lamports);
      const minLamports =
        lamportsValues.length > 0 ? Math.min(...lamportsValues) : 0;
      const maxLamports =
        lamportsValues.length > 0 ? Math.max(...lamportsValues) : 0;

      const totalSol = totalLamports / LAMPORTS_PER_SOL;

      refreshed.push({
        tokenAddress: token,
        fetched: result.holders.length,
        eligibleOwners: result.eligibleOwners,
        totalLamports,
        totalSol,
        minLamports,
        maxLamports,
        status: "updated",
      });
      console.log(
        `[holders] ${token} done: fetched=${result.holders.length}, eligible=${
          result.eligibleOwners
        }, totalSol=${totalSol.toFixed(2)}`
      );
    } catch (err) {
      refreshed.push({
        tokenAddress: token,
        fetched: 0,
        eligibleOwners: 0,
        totalLamports: 0,
        totalSol: 0,
        minLamports: 0,
        maxLamports: 0,
        status: "error",
        reason: (err as Error)?.message ?? String(err),
      });
      console.error(`[holders] ${token} failed`, err);
    }
  }

  if (tokensToFetch.length > 0) {
    const updated = Array.from(existingMap.values());
    await writeJsonFile(filePath, updated);
  } else {
    refreshed.push({
      tokenAddress: "all",
      fetched: 0,
      eligibleOwners: 0,
      totalLamports: 0,
      totalSol: 0,
      minLamports: 0,
      maxLamports: 0,
      status: "skipped",
      reason: "No tokens required refresh",
    });
  }

  return {
    filePath,
    tokensPlanned: tokensToFetch,
    refreshed,
  };
};

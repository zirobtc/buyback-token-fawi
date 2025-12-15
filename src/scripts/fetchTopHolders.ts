import fs from "fs/promises";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { HOLDERS_JSON_PATH, MIN_HOLDER_TOKEN_AMOUNT } from "../config";
import {
  createConnection,
  fetchMintWithProgram
} from "../utils/solana";

type HolderRecord = {
  tokenAddress: string;
  holders: string[];
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

const fetchTopHoldersRpc = async ({
  tokenAddress,
  limit,
  minTokenAmount,
  minHolderBalanceLamports
}: {
  tokenAddress: string;
  limit: number;
  minTokenAmount: number;
  minHolderBalanceLamports: number;
}): Promise<string[]> => {
  const connection = createConnection();
  const mintPk = new PublicKey(tokenAddress);
  const { mint, programId } = await fetchMintWithProgram(connection, mintPk);
  const decimals = mint.decimals ?? 0;
  const minRaw = BigInt(
    Math.floor(minTokenAmount * Math.pow(10, decimals))
  );
  
  // The logic must branch based on the token program.
  // - `spl-token` (legacy) can use `getTokenLargestAccounts`.
  // - `token-2022` (used by pump.fun) requires `getProgramAccounts` as `getTokenLargestAccounts` is not supported and `getParsedProgramAccounts` is often restricted on public RPCs.
  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    // The getParsedProgramAccounts method is often restricted on public RPCs for Token-2022.
    // We will use getProgramAccounts and parse manually, which is more reliable.
    const accounts = await connection.getProgramAccounts(programId, {
      // Do NOT set dataSize. Token-2022 accounts often have extensions (transfer hook, fees, etc.)
      // which increase the size beyond the legacy 165 bytes and would cause holders to be filtered out.
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: mintPk.toBase58(),
          },
        }
      ]
    });

    // A single owner can have multiple token accounts. We must aggregate their balances.
    const holderAmounts = new Map<string, bigint>();
    accounts.forEach((acc) => {
      try {
        // Manually parse the account data
        const owner = new PublicKey(acc.account.data.slice(32, 64));
        const amount = acc.account.data.readBigUInt64LE(64);
        const ownerAddress = owner.toBase58();
        const currentAmount = holderAmounts.get(ownerAddress) ?? 0n;
        holderAmounts.set(ownerAddress, currentAmount + amount);
      } catch (e) {
        // Should not happen, but as a safeguard
        console.warn("Failed to parse a token account, skipping.", e);
      }
    });

    // Filter out wallets with a token amount less than the minimum.
    // Crucially, if minRaw is 0, we still only want holders with a balance > 0.
    const filteredHolders = Array.from(holderAmounts.entries())
      .filter(([_, amount]) => amount > 0n && amount >= minRaw)
      .sort(([, amountA], [, amountB]) => (amountA < amountB ? 1 : -1));
    console.log(
      `[holders][${tokenAddress}] token-2022 accounts=${accounts.length}, owners>=minTokens=${filteredHolders.length}`
    );

    // Now, filter by native SOL balance
    const holderPubkeys = filteredHolders.map(([owner]) => new PublicKey(owner));
    const holdersWithBalance: string[] = [];

    // Fetch balances in batches of 100 (RPC limit)
    for (let i = 0; i < holderPubkeys.length; i += 100) {
      if (holdersWithBalance.length >= limit) break;

      const batch = holderPubkeys.slice(i, i + 100);
      const balances = await connection.getMultipleAccountsInfo(batch);

      for (let j = 0; j < batch.length; j++) {
        const pubkey = batch[j];
        const accountInfo = balances[j];
        if (accountInfo && accountInfo.lamports >= minHolderBalanceLamports) {
          holdersWithBalance.push(pubkey.toBase58());
          if (holdersWithBalance.length >= limit) {
            break;
          }
        }
      }
    }

    console.log(
      `[holders][${tokenAddress}] owners>=SOL=${holdersWithBalance.length} (limit ${limit}, minSOL=${minHolderBalanceLamports / LAMPORTS_PER_SOL})`
    );
    return holdersWithBalance;

  } else {
    // This branch handles legacy SPL tokens.
    const res = await connection.getTokenLargestAccounts(mintPk);
    if (!res?.value) {
      return [];
    }
    const holdersWithBalance: string[] = [];
    const eligibleTokenAccounts = res.value.filter((info) => {
      const amount = BigInt(info.amount);
      return info.address && amount > 0n && amount >= minRaw;
    });
    console.log(
      `[holders][${tokenAddress}] spl-token largest accounts returned=${res.value.length}, eligible>=minTokens=${eligibleTokenAccounts.length}`
    );
    // Fetch balances in batches of 100
    for (const info of eligibleTokenAccounts) {
      if (holdersWithBalance.length >= limit) break;

      try {
        // getTokenLargestAccounts returns the token account address, so fetch the owner before checking SOL balance.
        const tokenAcc = await connection.getAccountInfo(info.address);
        const owner =
          tokenAcc && tokenAcc.data.length >= 64
            ? new PublicKey(tokenAcc.data.slice(32, 64))
            : null;
        if (!owner) continue;

        const balance = await connection.getBalance(owner);
        if (balance >= minHolderBalanceLamports) {
          holdersWithBalance.push(owner.toBase58());
        }
      } catch (e) {
        // Ignore errors for single accounts
      }
    }

    console.log(
      `[holders][${tokenAddress}] owners>=SOL=${holdersWithBalance.length} (limit ${limit}, minSOL=${minHolderBalanceLamports / LAMPORTS_PER_SOL})`
    );
    return holdersWithBalance;
  }
};

const main = async () => {
  const filePath = process.env.HOLDERS_JSON_PATH ?? HOLDERS_JSON_PATH;
  const maxHolders = Number(process.env.MAX_FETCH_HOLDERS ?? "5000");
  const refetchAll = process.env.REFETCH_ALL === "true";
  const tokensEnv = (process.env.TOKENS ?? process.env.TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const existing = await parseJsonFile(filePath);
  const existingMap = new Map<string, HolderRecord>();
  existing.forEach((r) => existingMap.set(r.tokenAddress, r));

  const tokens = Array.from(
    new Set<string>([
      ...existing.map((r) => r.tokenAddress),
      ...tokensEnv
    ]).values()
  );

  if (tokens.length === 0) {
    console.warn("No tokens provided in holders file or TOKENS env");
    return;
  }

  const minTokenAmount =
    process.env.MIN_HOLDER_TOKEN_AMOUNT !== undefined
      ? Number(process.env.MIN_HOLDER_TOKEN_AMOUNT)
      : MIN_HOLDER_TOKEN_AMOUNT;

  const minHolderBalanceLamports = Math.floor(
    Number(process.env.MIN_HOLDER_BALANCE_SOL ?? "0") * LAMPORTS_PER_SOL
  );

  console.log(`Fetching holders for ${tokens.length} token(s) via RPC`);
  console.log(`Min holder token amount: ${minTokenAmount}`);
  console.log(`Min holder SOL balance: ${minHolderBalanceLamports / LAMPORTS_PER_SOL} SOL`);
  for (const token of tokens) {
    const current = existingMap.get(token);
    if (current?.holders?.length && !refetchAll) {
      console.log(`Skipping ${token}, already has ${current.holders.length} holders`);
      continue;
    }

    try {
      const holders = await fetchTopHoldersRpc({
        tokenAddress: token,
        limit: maxHolders,
        minTokenAmount,
        minHolderBalanceLamports
      });
      existingMap.set(token, { tokenAddress: token, holders });
      console.log(`Fetched ${holders.length} holders for ${token}`);
    } catch (err) {
      console.error(`Failed to fetch holders for ${token}:`, err);
    }
  }

  const updated = Array.from(existingMap.values());
  await writeJsonFile(filePath, updated);
  console.log(`Updated holders file at ${filePath}`);
};

main().catch((err) => {
  console.error("fetchTopHolders failed", err);
  process.exit(1);
});

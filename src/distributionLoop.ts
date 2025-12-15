import fs from "fs/promises";
import path from "path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount
} from "@pump-fun/pump-sdk";
import {
  BUYBACK_POLL_INTERVAL_MS,
  BUYBACK_SOL_CAP_LAMPORTS,
  BUYBACK_TRIGGER_LAMPORTS,
  DEFAULT_SLIPPAGE_BPS,
  DISTRIBUTION_BATCH_SIZE,
  MIN_HOLDER_BALANCE_LAMPORTS,
  MIN_DISTRIBUTABLE_TOKENS,
  loadDevWallet
} from "./config";
import { fetchRecipientWallets } from "./trendingWallets";
import { PauseSwitch, sleep } from "./utils/control";
import { createConnection, fetchMintWithProgram } from "./utils/solana";

export type DistributionOptions = {
  connection?: Connection;
  sdk?: PumpSdk;
  devWallet?: Keypair;
  mint: PublicKey;
  pollIntervalMs?: number;
  buybackTriggerLamports?: number;
  buybackSolCapLamports?: number;
  batchSize?: number;
  pauseSwitch?: PauseSwitch;
  slippageBps?: number;
};

const STATE_PATH =
  process.env.DISTRIBUTION_STATE_PATH ?? "./distribution-state.json";
const PEEL_LOG_PATH =
  process.env.DISTRIBUTION_PEEL_LOG_PATH ?? "./distribution-peels.log";
const MAX_TARGETS =
  Number(process.env.DISTRIBUTION_TARGETS ?? "1000") || 1000;
const RECIPIENT_FETCH_SIZE =
  Number(process.env.DISTRIBUTION_FETCH_SIZE ?? "3000") || 3000;
const MAX_SEND_RETRIES = 3;

type DistributionState = {
  sent: Record<string, string[]>;
};

const bigIntToSafeNumber = (value: bigint) => {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max) {
    throw new Error("Value exceeds MAX_SAFE_INTEGER, adjust transfer sizing");
  }
  return Number(value);
};

const loadState = async (): Promise<DistributionState> => {
  try {
    const raw = await fs.readFile(path.resolve(STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as DistributionState;
    if (parsed && typeof parsed === "object" && parsed.sent) {
      return { sent: parsed.sent };
    }
  } catch {
    // ignore, will create fresh state
  }
  return { sent: {} };
};

const persistState = async (state: DistributionState) => {
  await fs.writeFile(
    path.resolve(STATE_PATH),
    JSON.stringify(state, null, 2),
    "utf8"
  );
};

const appendPeelLog = async (entry: Record<string, unknown>) => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  });
  await fs.appendFile(path.resolve(PEEL_LOG_PATH), `${line}\n`, "utf8");
};

const shuffleInPlace = <T>(arr: T[]) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
};

const randomSplit = (total: bigint, parts: number) => {
  if (parts <= 0) return [];
  const weights = Array.from({ length: parts }, () =>
    BigInt(1 + Math.floor(Math.random() * 100))
  );
  const weightSum = weights.reduce((acc, w) => acc + w, 0n);
  const allocations: bigint[] = [];
  let remaining = total;
  for (let i = 0; i < parts; i++) {
    if (i === parts - 1) {
      allocations.push(remaining);
      break;
    }
    const share = (total * weights[i]) / weightSum;
    const amount = share > 0n ? share : 1n;
    allocations.push(amount);
    remaining -= amount;
  }
  return allocations;
};

const buildDistributionInstructions = ({
  devWallet,
  peelWallet,
  mint,
  devAta,
  recipient,
  amount,
  tokenProgram
}: {
  devWallet: Keypair;
  peelWallet: Keypair;
  mint: PublicKey;
  devAta: PublicKey;
  recipient: PublicKey;
  amount: bigint;
  tokenProgram: PublicKey;
}) => {
  const peelAta = getAssociatedTokenAddressSync(
    mint,
    peelWallet.publicKey,
    true,
    tokenProgram
  );
  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    true,
    tokenProgram
  );

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      devWallet.publicKey,
      peelAta,
      peelWallet.publicKey,
      mint,
      tokenProgram
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      devWallet.publicKey,
      recipientAta,
      recipient,
      mint,
      tokenProgram
    ),
    createTransferInstruction(
      devAta,
      peelAta,
      devWallet.publicKey,
      bigIntToSafeNumber(amount),
      [],
      tokenProgram
    ),
    createTransferInstruction(
      peelAta,
      recipientAta,
      peelWallet.publicKey,
      bigIntToSafeNumber(amount),
      [],
      tokenProgram
    ),
    createCloseAccountInstruction(
      peelAta,
      devWallet.publicKey,
      peelWallet.publicKey,
      [],
      tokenProgram
    )
  ];

  return { instructions, peelAta, recipientAta };
};

const getBuyAmount = ({
  global,
  bondingCurve,
  solAmount
}: {
  global: any;
  bondingCurve: any;
  solAmount: BN;
}) =>
  getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: null,
    mintSupply: null,
    bondingCurve,
    amount: solAmount
  });

const estimateTxFee = async (
  connection: Connection,
  instructions: Transaction["instructions"],
  feePayer: PublicKey,
  signers: Keypair[]
) => {
  try {
    const recent = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer, ...recent });
    tx.add(...instructions);
    signers.forEach((s) => tx.partialSign(s));
    const { value } = await connection.getFeeForMessage(tx.compileMessage());
    return value ?? 5000;
  } catch {
    return 5000;
  }
};

type SendResult = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

const sendWithRetry = async (
  connection: Connection,
  instructions: Transaction["instructions"],
  feePayer: PublicKey,
  signers: Keypair[],
  label: string,
  maxAttempts: number = MAX_SEND_RETRIES
): Promise<SendResult> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const recent = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer, ...recent });
      tx.add(...instructions);
      signers.forEach((s) => tx.partialSign(s));
      const sig = await connection.sendTransaction(tx, signers, {
        skipPreflight: false
      });
      return {
        signature: sig,
        blockhash: recent.blockhash,
        lastValidBlockHeight: recent.lastValidBlockHeight
      };
    } catch (err) {
      lastError = err;
      const message = (err as any)?.message ?? "";
      const isRateLimit =
        message.includes("429") || message.toLowerCase().includes("too many");
      const backoffMs = 500 * attempt;
      console.warn(
        `${label} attempt ${attempt} failed${isRateLimit ? " (rate limited)" : ""}, retrying in ${backoffMs}ms...`,
        message || err
      );
      await sleep(backoffMs);
    }
  }
  throw lastError;
};

export const runDistributionLoop = async ({
  connection,
  sdk: providedSdk,
  devWallet,
  mint,
  pollIntervalMs = BUYBACK_POLL_INTERVAL_MS,
  buybackTriggerLamports = BUYBACK_TRIGGER_LAMPORTS,
  buybackSolCapLamports = BUYBACK_SOL_CAP_LAMPORTS,
  batchSize = DISTRIBUTION_BATCH_SIZE,
  pauseSwitch = new PauseSwitch(),
  slippageBps = DEFAULT_SLIPPAGE_BPS
}: DistributionOptions) => {
  const conn = connection ?? createConnection();
  const { programId: tokenProgram } = await fetchMintWithProgram(conn, mint);
  const offlineSdk = providedSdk ?? new PumpSdk();
  const onlineSdk = new OnlinePumpSdk(conn);
  const dev = devWallet ?? loadDevWallet();
  const devAta = getAssociatedTokenAddressSync(
    mint,
    dev.publicKey,
    true,
    tokenProgram
  );
  const triggerLamports = Math.max(0, Math.floor(buybackTriggerLamports));
  const capLamports = Math.max(0, Math.floor(buybackSolCapLamports));
  const minAtaRent = await conn.getMinimumBalanceForRentExemption(165);
  const state = await loadState();
  const mintKey = mint.toBase58();
  const sentSet = new Set<string>(state.sent[mintKey] ?? []);
  let cachedFeeEstimate: number | null = null;

  while (true) {
    if (pauseSwitch.paused) {
      await sleep(1000);
      continue;
    }

    // Check creator fee vault.
    const vaultLamports =
      (await onlineSdk
        .getCreatorVaultBalanceBothPrograms(dev.publicKey)
        .catch(() => new BN(0))) ?? new BN(0);

    if (vaultLamports.lt(new BN(triggerLamports))) {
      console.log(
        `[loop] Waiting: vault=${vaultLamports.toString()} lamports, trigger=${triggerLamports}`
      );
      await sleep(pollIntervalMs);
      continue;
    }

    const preClaimBalance = await conn.getBalance(dev.publicKey);

    // Claim creator fees to the dev wallet.
    try {
      const collectIxs =
        (await onlineSdk.collectCoinCreatorFeeInstructions(dev.publicKey)) ??
        [];
      if (collectIxs && collectIxs.length > 0) {
        const { signature: collectSig } = await sendWithRetry(
          conn,
          collectIxs,
          dev.publicKey,
          [dev],
          "collect-fees"
        );
        console.log("Collected creator fees, tx", collectSig);
      }
    } catch (err) {
      console.error("Fee collection failed", err);
      await sleep(pollIntervalMs);
      continue;
    }

    const postClaimBalance = await conn.getBalance(dev.publicKey);
    const claimedLamports = Math.max(0, postClaimBalance - preClaimBalance);

    const lamportsBalance = await conn.getBalance(dev.publicKey);
    const vaultAvailable = vaultLamports.gt(new BN(Number.MAX_SAFE_INTEGER))
      ? Number.MAX_SAFE_INTEGER
      : vaultLamports.toNumber();
    const cap = capLamports > 0 ? capLamports : lamportsBalance;

    const availableForSpend =
      claimedLamports > 0 ? claimedLamports : Math.min(vaultAvailable, cap);
    if (claimedLamports < triggerLamports) {
      console.warn(
        `Claimed lamports ${claimedLamports} below trigger ${triggerLamports}, attempting buyback with available ${availableForSpend}`
      );
    }

    const spendLamports = Math.min(
      lamportsBalance,
      cap,
      vaultAvailable,
      availableForSpend
    );
    if (spendLamports <= 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    let buyAmount: BN | null = null;
    try {
      const global = await onlineSdk.fetchGlobal();
      const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
        await onlineSdk.fetchBuyState(mint, dev.publicKey, tokenProgram);

      const solAmount = new BN(spendLamports);
      buyAmount = getBuyAmount({ global, bondingCurve, solAmount });

      const buyArgs: any = {
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint,
        user: dev.publicKey,
        solAmount,
        amount: buyAmount,
        tokenProgram
      };
      if (slippageBps !== undefined) {
        buyArgs.slippage = slippageBps;
      }

      const buyIxs = await offlineSdk.buyInstructions(buyArgs);
      const buyResult = await sendWithRetry(
        conn,
        buyIxs,
        dev.publicKey,
        [dev],
        "buyback"
      );
      await conn.confirmTransaction(
        {
          signature: buyResult.signature,
          blockhash: buyResult.blockhash,
          lastValidBlockHeight: buyResult.lastValidBlockHeight
        },
        "confirmed"
      );
      console.log(
        `Bought back with ${spendLamports} lamports, tx ${buyResult.signature}, amount ${buyAmount.toString()}`
      );
    } catch (err) {
      console.error("Buyback failed", err);
      await sleep(pollIntervalMs);
      continue;
    }

    if (!buyAmount) {
      console.warn("Buyback amount unavailable, skipping distribution.");
      await sleep(pollIntervalMs);
      continue;
    }

    const newlyAcquired = BigInt(buyAmount.toString());
    console.log(
      `[distribution] Newly acquired ${newlyAcquired.toString()} base units from buyback`
    );

    if (newlyAcquired < MIN_DISTRIBUTABLE_TOKENS) {
      console.warn("No new tokens to distribute after buyback");
      await sleep(pollIntervalMs);
      continue;
    }

    console.log(
      `[distribution] Fetching recipients (maxRecipients=${RECIPIENT_FETCH_SIZE})`
    );
    const recipients = await fetchRecipientWallets({
      maxRecipients: RECIPIENT_FETCH_SIZE,
      maxHoldersPerToken: 10000,
      connection: conn
    });
    console.log(
      `[distribution] Loaded ${recipients.length} recipients (fetch_size=${RECIPIENT_FETCH_SIZE})`
    );
    if (recipients.length === 0) {
      console.warn("No recipient wallets found, sleeping...");
      await sleep(pollIntervalMs);
      continue;
    }

    shuffleInPlace(recipients);
    const eligible = recipients.filter((r) => !sentSet.has(r.toBase58()));
    console.log(
      `[distribution] Eligible recipients not yet sent to: ${eligible.length} (already_sent=${sentSet.size})`
    );
    if (eligible.length === 0) {
      console.warn("All recipients have already been sent to, sleeping...");
      await sleep(pollIntervalMs);
      continue;
    }

    const targetCount = Math.min(
      eligible.length,
      MAX_TARGETS,
      batchSize,
      recipients.length
    );
    const selected = eligible.slice(0, targetCount);
    const splits = randomSplit(newlyAcquired, selected.length);
    console.log(
      `[distribution] Selected ${selected.length} recipients for this batch (maxTargets=${MAX_TARGETS}, batchSize=${batchSize})`
    );

    const pairs = selected
      .map((recipient, idx) => ({
        recipient,
        amount: splits[idx]
      }))
      .filter((p) => p.amount >= MIN_DISTRIBUTABLE_TOKENS);

    if (pairs.length === 0) {
      console.warn("Token amount too low to split, sleeping...");
      await sleep(pollIntervalMs);
      continue;
    }

    let availableLamports = await conn.getBalance(dev.publicKey);
    console.log(
      `[distribution] Beginning sends with ${availableLamports} lamports available`
    );

    for (const { recipient, amount } of pairs) {
      if (amount < MIN_DISTRIBUTABLE_TOKENS) continue;

      const peelWallet = Keypair.generate();
      console.log(
        `[distribution] Created peel ${peelWallet.publicKey.toBase58()} for recipient ${recipient.toBase58()} amount ${amount.toString()}`
      );
      const { instructions, peelAta, recipientAta } = buildDistributionInstructions({
        devWallet: dev,
        peelWallet,
        mint,
        devAta,
        recipient,
        amount,
        tokenProgram
      });

      try {
        if (!cachedFeeEstimate) {
          cachedFeeEstimate = await estimateTxFee(
            conn,
            instructions,
            dev.publicKey,
            [dev, peelWallet]
          );
        }
        const totalLamportsNeeded = cachedFeeEstimate + minAtaRent * 2;
        if (availableLamports < totalLamportsNeeded) {
          console.warn(
            `Insufficient SOL for peel distribution (need ~${totalLamportsNeeded}, have ${availableLamports}). Skipping ${recipient.toBase58()}`
          );
          continue;
        }
        availableLamports -= totalLamportsNeeded;

        const { signature } = await sendWithRetry(
          conn,
          instructions,
          dev.publicKey,
          [dev, peelWallet],
          "distribution"
        );
        sentSet.add(recipient.toBase58());
        console.log(
          `Distributed ${amount.toString()} base units to ${recipient.toBase58()} via peel ${peelWallet.publicKey.toBase58()}, tx ${signature}, remaining lamports ~${availableLamports}`
        );
        await appendPeelLog({
          mint: mintKey,
          recipient: recipient.toBase58(),
          peel: peelWallet.publicKey.toBase58(),
          peelAta: peelAta.toBase58(),
          recipientAta: recipientAta.toBase58(),
          amount: amount.toString(),
          tx: signature
        });
      } catch (err) {
        console.error("Distribution transfer failed", err);
      }
    }

    state.sent[mintKey] = Array.from(sentSet.values());
    await persistState(state);

    await sleep(pollIntervalMs);
  }
};

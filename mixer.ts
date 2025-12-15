import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { CONFIG } from "../config";
import {
  loadWalletsFromFile,
  safeGenerateAndSaveWallet,
} from "./wallet-manager";
import fs from "fs/promises";
import path from "path";

// --- HELPER FUNCTIONS ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRpcRetry<T>(
  action: () => Promise<T>,
  actionName: string = "RPC action"
): Promise<T> {
  let attempt = 1;
  while (true) {
    try {
      return await action();
    } catch (error: any) {
      const sleepTime = Math.min(1500 * attempt, 30000); // Cap sleep time at 30s
      console.warn(
        `[WARN] ${actionName} failed on attempt ${attempt}. Retrying in ${Math.round(
          sleepTime / 1000
        )}s... Error: ${error.message}`
      );
      await sleep(sleepTime);
      attempt++;
    }
  }
}

async function executeRandomDelay(minMs: number, maxMs: number): Promise<void> {
  if (minMs >= maxMs) {
    if (minMs > 0) await sleep(minMs);
    return;
  }
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log(
    `(Pausing for ${Math.round(delay / 1000)}s to break temporal links...)`
  );
  await sleep(delay);
}

function splitAmountRandomly(totalAmount: number, numParts: number): number[] {
  if (numParts <= 0) return [];
  if (numParts === 1) return [totalAmount];
  const randoms = Array.from({ length: numParts - 1 }, () => Math.random());
  randoms.push(0, 1);
  randoms.sort();
  const parts: number[] = [];
  for (let i = 1; i < randoms.length; i++) {
    parts.push((randoms[i] - randoms[i - 1]) * totalAmount);
  }
  return parts;
}

async function sendSol(
  connection: Connection,
  fromKeypair: Keypair,
  toPublicKey: PublicKey,
  amountSol: number
): Promise<string> {
  // Note: No longer returns null
  if (amountSol <= 0) {
    // This case should ideally not be reached if logic is correct, but as a safeguard:
    console.warn(
      `[WARN] sendSol called with amount <= 0. Skipping transaction.`
    );
    return ""; // Return an empty string to signify no transaction was sent.
  }

  const lamportsToSend = Math.floor(amountSol * LAMPORTS_PER_SOL);
  let attempt = 1;
  while (true) {
    try {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: toPublicKey,
          lamports: lamportsToSend,
        })
      );
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [fromKeypair]
      );
      return signature;
    } catch (error: any) {
      const sleepTime = Math.min(2000 * attempt, 60000); // Cap sleep time at 60s
      console.error(
        `[ERROR] TX from ${fromKeypair.publicKey
          .toBase58()
          .substring(
            0,
            4
          )} FAILED on attempt ${attempt}. Retrying in ${Math.round(
          sleepTime / 1000
        )}s...`,
        error.message
      );
      await sleep(sleepTime);
      attempt++;
    }
  }
}

async function sweepWallet(
  connection: Connection,
  fromKeypair: Keypair,
  toPublicKey: PublicKey
): Promise<string | null> {
  const balance = await withRpcRetry(() =>
    connection.getBalance(fromKeypair.publicKey)
  );
  const fee = 5000;
  if (balance <= fee) return null;
  const amountToSweepSol = (balance - fee) / LAMPORTS_PER_SOL;
  return await sendSol(connection, fromKeypair, toPublicKey, amountToSweepSol);
}

async function getOrGenerateWallets(
  count: number,
  type: "pool",
  filePath: string
): Promise<Keypair[]> {
  let existingWallets: Keypair[] = [];
  try {
    existingWallets = await loadWalletsFromFile(filePath);
  } catch (e) {}
  if (existingWallets.length >= count) {
    return existingWallets.slice(0, count);
  }
  const needed = count - existingWallets.length;
  console.log(
    `ℹ️ Found ${existingWallets.length} ${type} wallets. Generating ${needed} new one(s)...`
  );
  for (let i = 0; i < needed; i++) {
    const newWallet = await safeGenerateAndSaveWallet(type);
    existingWallets.push(newWallet);
  }
  return existingWallets;
}

// --- MAIN MIXING LOGIC ---

export async function initiateMixing(): Promise<void> {
  const connection = new Connection(CONFIG.RPC_URL, "processed");

  // --- STAGE 1: Planning & Setup ---
  console.log("\n--- STAGE 1: Planning & Setup ---");
  const sourceWallets = await loadWalletsFromFile(CONFIG.SOURCE_WALLETS_FILE);
  const targetWallets = await loadWalletsFromFile(CONFIG.TARGET_WALLETS_FILE);
  if (sourceWallets.length === 0 || targetWallets.length === 0) {
    console.error("❌ Source or Target wallets not found. Aborting.");
    return;
  }
  const poolWallets = await getOrGenerateWallets(
    CONFIG.POOL_WALLET_COUNT,
    "pool",
    CONFIG.POOL_WALLETS_FILE
  );

  console.log("-> Loading funding map...");
  // Define the type for clarity
  type FundingMap = { publicKey: string; targetAmount: number }[];
  let fundingTargets: Map<string, number>;
  try {
    const fundingMapData = await fs.readFile(CONFIG.FUNDING_MAP_FILE, "utf-8");
    const fundingMapJson: FundingMap = JSON.parse(fundingMapData);
    // Convert array to a Map for efficient O(1) lookups
    fundingTargets = new Map(
      fundingMapJson.map((item) => [item.publicKey, item.targetAmount])
    );
    console.log(`✅ Loaded ${fundingTargets.size} specific funding targets.`);
  } catch (error) {
    console.error(
      `❌ Failed to load or parse funding map from ${CONFIG.FUNDING_MAP_FILE}. Aborting.`,
      error
    );
    return;
  }

  const targetPeelWalletMap = new Map<string, Keypair>();
  const peelMapFilePath = path.join(
    path.dirname(CONFIG.PEEL_WALLETS_FILE),
    CONFIG.PEEL_MAP_FILE
  );
  try {
    const data = await fs.readFile(peelMapFilePath, "utf-8");
    const parsed = JSON.parse(data);
    for (const [targetAddr, secretKey] of Object.entries(parsed)) {
      targetPeelWalletMap.set(
        targetAddr,
        Keypair.fromSecretKey(new Uint8Array(secretKey as number[]))
      );
    }
    console.log(
      `✅ Loaded ${targetPeelWalletMap.size} dedicated peel wallets.`
    );
  } catch (e) {
    console.log(`ℹ️ No existing peel wallet map found. Will create a new one.`);
  }

  let totalNeededLamports = 0;
  const withdrawalTasks: {
    targetWallet: Keypair;
    amountSol: number;
    peelWallet: Keypair;
  }[] = [];

  const rentExemptionLamports = await withRpcRetry(() =>
    connection.getMinimumBalanceForRentExemption(0)
  );
  const minChunkLamports = rentExemptionLamports + 5000;

  for (const targetWallet of targetWallets) {
    const targetAddress = targetWallet.publicKey.toBase58();
    if (!targetPeelWalletMap.has(targetAddress)) {
      const newPeel = await safeGenerateAndSaveWallet("peel");
      targetPeelWalletMap.set(targetAddress, newPeel);
      const mapToSave: { [key: string]: number[] } = {};
      targetPeelWalletMap.forEach((kp, addr) => {
        mapToSave[addr] = Array.from(kp.secretKey);
      });
      await fs.writeFile(peelMapFilePath, JSON.stringify(mapToSave, null, 2));
    }
    const dedicatedPeelWallet = targetPeelWalletMap.get(targetAddress)!;

    const balance = await withRpcRetry(() =>
      connection.getBalance(targetWallet.publicKey)
    );

    // -- Get target balance
    const specificTargetAmount = fundingTargets.get(targetAddress);

    if (specificTargetAmount === undefined) {
      console.warn(
        `[WARN] Wallet ${targetAddress.substring(
          0,
          4
        )}... not found in funding map. Skipping.`
      );
      continue; // Skip this wallet as no target amount is defined
    }

    const targetBalance = specificTargetAmount * LAMPORTS_PER_SOL;
    let neededLamports = Math.max(0, targetBalance - balance);

    if (neededLamports > 0) {
      // **THE FIX**: If the required top-up is too small, round it UP to the safe minimum.
      if (neededLamports < minChunkLamports) {
        neededLamports = minChunkLamports;
      }

      totalNeededLamports += neededLamports;
      const maxPossibleChunks = Math.floor(neededLamports / minChunkLamports);
      let numChunks =
        Math.floor(
          Math.random() *
            (CONFIG.MAX_WITHDRAW_CHUNKS - CONFIG.MIN_WITHDRAW_CHUNKS + 1)
        ) + CONFIG.MIN_WITHDRAW_CHUNKS;
      if (numChunks > maxPossibleChunks) {
        numChunks = maxPossibleChunks;
      }
      if (numChunks <= 0) numChunks = 1;

      const chunksSol = splitAmountRandomly(
        neededLamports / LAMPORTS_PER_SOL,
        numChunks
      );
      for (const chunkSol of chunksSol) {
        withdrawalTasks.push({
          targetWallet,
          amountSol: chunkSol,
          peelWallet: dedicatedPeelWallet,
        });
      }
    }
  }

  if (totalNeededLamports === 0) {
    console.log(
      "✅ All target wallets are sufficiently funded. Nothing to do."
    );
    return;
  }
  // --- Stages 2 & 3 ---
  console.log(
    `✅ Plan complete. Total to mix: ${
      totalNeededLamports / LAMPORTS_PER_SOL
    } SOL for ${withdrawalTasks.length} total chunks.`
  );
  console.log("\n--- STAGE 2: Funding the Pools ---");
  /*
  const totalToDepositSOL =
    totalNeededLamports / LAMPORTS_PER_SOL + CONFIG.DEPOSIT_FEE_BUFFER_SOL;
  const depositAmountPerSource = totalToDepositSOL / sourceWallets.length;
  for (const source of sourceWallets) {
    const pool = poolWallets[Math.floor(Math.random() * poolWallets.length)];
    const sig = await sendSol(
      connection,
      source,
      pool.publicKey,
      depositAmountPerSource
    );
    if (!sig) {
      console.error(
        ` -> ❌ CRITICAL: Failed to deposit from ${source.publicKey.toBase58()}. Aborting.`
      );
      return;
    }
  }*/

  const requiredPoolBalanceForCompletionSOL =
    totalNeededLamports / LAMPORTS_PER_SOL + CONFIG.DEPOSIT_FEE_BUFFER_SOL;

  // Check current aggregate balance of pool wallets
  const currentPoolBalancesLamports = await withRpcRetry(async () => {
    let sum = 0;
    for (const poolWallet of poolWallets) {
      sum += await connection.getBalance(poolWallet.publicKey);
    }
    return sum;
  }, "Checking pool wallet balances");

  const requiredPoolBalanceForCompletionLamports = Math.floor(
    requiredPoolBalanceForCompletionSOL * LAMPORTS_PER_SOL
  );

  // Small tolerance for residual dust/minor rounding differences.
  // If current balance is within this tolerance, consider it sufficiently funded.
  const dustToleranceLamports = 10000; // 0.00001 SOL

  if (
    currentPoolBalancesLamports >=
    requiredPoolBalanceForCompletionLamports - dustToleranceLamports
  ) {
    console.log(
      `✅ Pool wallets already contain ${
        currentPoolBalancesLamports / LAMPORTS_PER_SOL
      } SOL. ` +
        `Sufficiently funded (needed ~${requiredPoolBalanceForCompletionSOL.toFixed(
          7
        )} SOL). Skipping initial deposit from source wallets.`
    );
    // Funds are already in the pool, so no need to deposit from sourceWallets
  } else {
    // Funds are not yet sufficient in pool wallets, proceed with deposit
    const deficitLamports =
      requiredPoolBalanceForCompletionLamports - currentPoolBalancesLamports;
    const deficitSOL = deficitLamports / LAMPORTS_PER_SOL; // CORRECTED: LAMPORTS_PER_SOL

    if (deficitSOL <= 0) {
      // Safety check in case calculation results in non-positive deficit
      console.log(
        "✅ Pool wallets already sufficiently funded. No further deposit needed."
      );
    } else {
      console.log(
        `ℹ️ Pool wallets need ${deficitSOL.toFixed(7)} SOL more. Depositing...`
      );

      // --- Handle tiny deficits with a single source wallet (or multiple if needed) ---
      let coveredDeficit = false;
      for (const source of sourceWallets) {
        const sourceBalance = await withRpcRetry(() =>
          connection.getBalance(source.publicKey)
        );
        const rentExemptReserve = await withRpcRetry(() =>
          connection.getMinimumBalanceForRentExemption(0)
        );
        const txFee = 5000; // Standard transaction fee for simple transfer

        // Check if this source wallet can cover the entire deficit + its own tx fee + leave enough for rent exemption
        // Note: This logic assumes a single source wallet covers the *entire* deficit.
        // If deficitSOL is very large and no single source wallet can cover it, this loop will fail.
        // For large deficits, the old 'depositAmountPerSource' logic is better.
        // However, this block is specifically for *tiny* remaining deficits after a prior partial run.
        if (sourceBalance >= deficitLamports + txFee + rentExemptReserve) {
          const pool =
            poolWallets[Math.floor(Math.random() * poolWallets.length)]; // Pick a random pool to deposit to
          const sig = await sendSol(
            connection,
            source,
            pool.publicKey,
            deficitSOL // Send the whole deficit amount
          );
          if (sig) {
            console.log(
              ` -> ✅ Covered deficit with ${deficitSOL.toFixed(
                7
              )} SOL from ${source.publicKey.toBase58().substring(0, 4)}...`
            );
            coveredDeficit = true;
            break; // Deficit covered, exit loop
          } else {
            console.error(
              ` -> ❌ Failed to cover deficit from ${source.publicKey
                .toBase58()
                .substring(0, 4)}... Trying next source wallet.`
            );
          }
        } else {
          console.log(
            ` -> ℹ️ Source wallet ${source.publicKey
              .toBase58()
              .substring(0, 4)}... (${
              sourceBalance / LAMPORTS_PER_SOL
            } SOL) not enough to cover full deficit and maintain rent. Trying next.`
          );
        }
      }

      if (!coveredDeficit) {
        console.error(
          "❌ CRITICAL: Could not cover deficit from any source wallet while maintaining rent exemption. Aborting."
        );
        return;
      }
      // --- END OF DEFICIT COVERAGE MODIFICATION ---

      console.log(
        "✅ All required funds have been deposited into the pool wallets."
      );
    }
  }
  // --- END OF MODIFICATION FOR SKIPPING DEPOSIT ---

  console.log(
    "✅ All required funds have been deposited into the pool wallets."
  );
  console.log(
    `\n--- STAGE 3: Shuffling funds across ${CONFIG.SHUFFLE_ROUNDS} rounds ---`
  );
  for (let i = 0; i < CONFIG.SHUFFLE_ROUNDS; i++) {
    const [pool1, pool2] = [
      poolWallets[Math.floor(Math.random() * poolWallets.length)],
      poolWallets[Math.floor(Math.random() * poolWallets.length)],
    ];
    if (pool1.publicKey.equals(pool2.publicKey)) continue;
    const balance1 = await withRpcRetry(() =>
      connection.getBalance(pool1.publicKey)
    );
    if (balance1 <= 5000) continue;
    const shufflePercent =
      (Math.random() *
        (CONFIG.MAX_SHUFFLE_PERCENT - CONFIG.MIN_SHUFFLE_PERCENT) +
        CONFIG.MIN_SHUFFLE_PERCENT) /
      100;
    const amountToShuffleSOL =
      ((balance1 - 5000) * shufflePercent) / LAMPORTS_PER_SOL;
    if (amountToShuffleSOL > 0) {
      await sendSol(connection, pool1, pool2.publicKey, amountToShuffleSOL);
    }
  }
  console.log("✅ Shuffle complete.");

  // --- STAGE 4: Withdrawals ---
  console.log("\n--- STAGE 4: Withdrawing funds to targets ---");
  async function executeWithdrawalTask(task: {
    targetWallet: Keypair;
    amountSol: number;
    peelWallet: Keypair;
  }): Promise<boolean> {
    const { targetWallet, amountSol, peelWallet } = task;

    let attempt = 0;
    while (attempt < 15) {
      attempt++;
      const poolBalances = await withRpcRetry(() =>
        Promise.all(poolWallets.map((p) => connection.getBalance(p.publicKey)))
      );
      const lamportsRequired = Math.ceil(amountSol * LAMPORTS_PER_SOL);
      let poolToUse: Keypair | null = null;
      let mustSweep = false;

      // Find a pool that can handle the transfer without becoming dust
      for (let i = 0; i < poolWallets.length; i++) {
        const balance = poolBalances[i];
        const remainder = balance - lamportsRequired - 5000;
        if (remainder >= rentExemptionLamports) {
          // Ideal case: pool has plenty of money left over
          poolToUse = poolWallets[i];
          break;
        }
        if (remainder >= 0 && remainder < rentExemptionLamports) {
          // Good case: we can sweep this pool to avoid the dust/zombie error
          poolToUse = poolWallets[i];
          mustSweep = true;
          break;
        }
      }

      if (poolToUse) {
        const targetAddress = targetWallet.publicKey.toBase58();
        console.log(
          ` -> [${targetAddress.substring(
            0,
            4
          )}] Withdrawing chunk of ${amountSol.toFixed(
            6
          )} SOL from pool ${poolToUse.publicKey.toBase58().substring(0, 4)}...`
        );

        // **THE FIX**: Decide whether to send a specific amount or sweep the whole wallet
        const sig1 = mustSweep
          ? await sweepWallet(connection, poolToUse, peelWallet.publicKey)
          : await sendSol(
              connection,
              poolToUse,
              peelWallet.publicKey,
              amountSol
            );

        if (!sig1) {
          console.error(`   -> ❌ FAILED to send from Pool to Peel.`);
          return false;
        }
        const sig2 = await sweepWallet(
          connection,
          peelWallet,
          targetWallet.publicKey
        );
        if (!sig2) {
          console.error(
            `   -> ❌ CRITICAL: SWEEP FAILED from peel ${peelWallet.publicKey.toBase58()}! Funds are stranded.`
          );
          return false;
        }
        console.log(`   -> ✅ Success! Peel-to-Target signature: ${sig2}`);
        return true; // Success, exit the task
      }

      // If we are here, no single pool was suitable. We must fund one.
      console.warn(
        `[WARN] No single pool is suitable for withdrawal. Attempting to fund one...`
      );

      const sleepTime = Math.min(4000 * attempt, 60000); // Start at 2s, cap at 60s
      console.warn(
        `[WARN] No single pool is suitable for withdrawal on attempt ${attempt}. Retrying in ${Math.round(
          sleepTime / 1000
        )}s...`
      );
      await sleep(sleepTime);
    }

    console.error(
      "❌ CRITICAL: Could not secure a funded pool after multiple attempts."
    );
    return false;
  }

  let pendingTasks = withdrawalTasks.sort(() => Math.random() - 0.5);
  const walletUnlockTimestamps: Map<string, number> = new Map();
  while (pendingTasks.length > 0) {
    let taskExecutedInThisPass = false;
    for (let i = pendingTasks.length - 1; i >= 0; i--) {
      const task = pendingTasks[i];
      const targetAddress = task.targetWallet.publicKey.toBase58();
      const isWalletUnlocked = walletUnlockTimestamps.has(targetAddress);
      let taskIsReady = isWalletUnlocked;

      if (!isWalletUnlocked) {
        if (walletUnlockTimestamps.size === 0) {
          walletUnlockTimestamps.set(targetAddress, Date.now());
          taskIsReady = true;
        } else {
          const lastUnlockTime = Math.max(
            ...Array.from(walletUnlockTimestamps.values())
          );
          if (
            Date.now() - lastUnlockTime >=
            CONFIG.MIN_TIME_BETWEEN_WALLETS_MS
          ) {
            walletUnlockTimestamps.set(targetAddress, Date.now());
            taskIsReady = true;
          }
        }
      }

      if (taskIsReady) {
        const success = await executeWithdrawalTask(task);
        if (success) {
          pendingTasks.splice(i, 1);
          taskExecutedInThisPass = true;
          await executeRandomDelay(
            CONFIG.MIN_WITHDRAW_DELAY_MS,
            CONFIG.MAX_WITHDRAW_DELAY_MS
          );
        } else {
          console.error("Stopping mixer due to critical task failure.");
          return;
        }
      }
    }
    if (!taskExecutedInThisPass && pendingTasks.length > 0) {
      console.log(
        `(Waiting for wallet separation timer... ${pendingTasks.length} tasks remaining)`
      );
      await sleep(5000);
    }
  }

  // --- STAGE 5 ---
  console.log("\n--- STAGE 5: Final Cleanup ---");
  let sourceIndex = 0;
  for (const pool of poolWallets) {
    const balance = await withRpcRetry(() =>
      connection.getBalance(pool.publicKey)
    );
    if (balance > 5000) {
      const destinationSource =
        sourceWallets[sourceIndex % sourceWallets.length];
      await sweepWallet(connection, pool, destinationSource.publicKey);
      sourceIndex++;
    }
  }
  console.log("✅ FINAL SWEEP COMPLETE. Mixer run finished successfully.");
}

// --- SCRIPT EXECUTION ---
async function main() {
  try {
    await initiateMixing();
  } catch (err) {
    console.error(
      "❌ An unexpected and critical error occurred during the mixing process:",
      err
    );
    process.exit(1);
  }
}

main();

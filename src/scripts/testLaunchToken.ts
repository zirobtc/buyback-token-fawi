import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

import { createAndBuy } from "../launchToken";
import { DEFAULT_BUY_LAMPORTS, DEFAULT_SLIPPAGE_BPS } from "../config";

const parseNumber = (value: string | undefined, fallback: number) => {
  const num = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(num) ? num : fallback;
};

const main = async () => {
  // Prefer explicit TEST_* overrides, then fall back to env defaults, then hard fallback to 0.01 SOL.
  const buySol = parseNumber(
    process.env.TEST_BUY_SOL ?? undefined,
    DEFAULT_BUY_LAMPORTS / LAMPORTS_PER_SOL
  );
  const slippageEnv = process.env.TEST_SLIPPAGE_BPS;
  const slippageBps = Number.isFinite(Number(slippageEnv))
    ? Number(slippageEnv)
    : DEFAULT_SLIPPAGE_BPS;

  console.log(`Launching token with initial buy of ~${buySol} SOL...`);
  const { signature, mint, devAta } = await createAndBuy({
    buyAmountLamports: Math.floor(buySol * LAMPORTS_PER_SOL),
    slippageBps
  });

  console.log("Launch+buy signature:", signature);
  console.log("Mint address:", mint.toBase58());
  console.log("Dev ATA:", devAta.toBase58());
};

main().catch((err) => {
  console.error("testLaunchToken failed", err);
  process.exit(1);
});

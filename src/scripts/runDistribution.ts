import { PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

import { runDistributionLoop } from "../distributionLoop";
import { loadDevWallet } from "../config";
import { loadKeypairFromSecret } from "../utils/solana";

const getMintFromEnv = (): PublicKey => {
  const secret = process.env.MINT_KEYPAIR_SECRET ?? process.env.MINT_SECRET;
  if (!secret) {
    throw new Error(
      "MINT_KEYPAIR_SECRET (or MINT_SECRET) is required to run distribution."
    );
  }
  return loadKeypairFromSecret(secret).publicKey;
};

const main = async () => {
  const mint = getMintFromEnv();
  const devWallet = loadDevWallet();

  console.log(`Starting distribution loop for mint ${mint.toBase58()}`);
  console.log(`Dev wallet ${devWallet.publicKey.toBase58()}`);

  await runDistributionLoop({
    mint,
    devWallet
  });
};

main().catch((err) => {
  console.error("Distribution loop failed", err);
  process.exit(1);
});

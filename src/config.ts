import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadKeypairFromSecret } from "./utils/solana";

export const RPC_ENDPOINT =
  process.env.RPC_ENDPOINT ?? "https://api.mainnet-beta.solana.com";

export const TOKEN_METADATA = {
  name: process.env.TOKEN_NAME ?? "Narrative Token",
  symbol: process.env.TOKEN_SYMBOL ?? "NARR",
  uri:
    process.env.TOKEN_URI ??
    "https://example.com/metadata.json" // replace with hosted metadata
};

export const DEFAULT_BUY_LAMPORTS = Math.floor(
  Number(process.env.DEFAULT_BUY_SOL ?? "1.5") * LAMPORTS_PER_SOL
);

export const DEFAULT_SLIPPAGE_BPS = Number(
  process.env.DEFAULT_SLIPPAGE_BPS ?? "300"
);

export const HOLDERS_JSON_PATH =
  process.env.HOLDERS_JSON_PATH ?? "./holders.json";

export const MIN_HOLDER_BALANCE_LAMPORTS = Math.floor(
  Number(process.env.MIN_HOLDER_BALANCE_SOL ?? "5") * LAMPORTS_PER_SOL
);

export const MIN_HOLDER_TOKEN_AMOUNT = Number(
  process.env.MIN_HOLDER_TOKEN_AMOUNT ?? "0"
);

export const BUYBACK_POLL_INTERVAL_MS = Number(
  process.env.BUYBACK_POLL_INTERVAL_MS ?? "10000"
);

export const BUYBACK_TRIGGER_LAMPORTS = Math.floor(
  Number(process.env.BUYBACK_TRIGGER_SOL ?? "0.1") * LAMPORTS_PER_SOL
);

export const BUYBACK_SOL_CAP_LAMPORTS = Math.floor(
  Number(process.env.BUYBACK_SOL_CAP ?? "0.5") * LAMPORTS_PER_SOL
);

export const DISTRIBUTION_BATCH_SIZE = Number(
  process.env.DISTRIBUTION_BATCH_SIZE ?? "20"
);

export const DISTRIBUTION_SLEEP_MS = Number(
  process.env.DISTRIBUTION_SLEEP_MS ?? "30000"
);

export const MIN_DISTRIBUTABLE_TOKENS = BigInt(
  process.env.MIN_DISTRIBUTABLE_TOKENS ?? "1"
);

export const DEV_WALLET_SECRET =
  process.env.DEV_WALLET_SECRET ?? "<paste base58 secret>";

export const loadDevWallet = () => loadKeypairFromSecret(DEV_WALLET_SECRET);

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getSettings } from "./settings";
import { loadKeypairFromSecret } from "./utils/solana";

const settings = getSettings();

export const RPC_ENDPOINT = settings.rpcEndpoint;

export const TOKEN_METADATA = {
  name: process.env.TOKEN_NAME ?? "Narrative Token",
  symbol: process.env.TOKEN_SYMBOL ?? "NARR",
  uri:
    process.env.TOKEN_URI ??
    "https://example.com/metadata.json" // replace with hosted metadata
};

export const DEFAULT_BUY_LAMPORTS = Math.floor(
  Number(settings.defaults.defaultBuySol ?? "1.5") * LAMPORTS_PER_SOL
);

export const DEFAULT_SLIPPAGE_BPS = Number(
  settings.defaults.defaultSlippageBps ?? "300"
);

export const HOLDERS_JSON_PATH =
  settings.holders.filePath ?? "./holders.json";

export const MIN_HOLDER_BALANCE_LAMPORTS = Math.floor(
  settings.holders.minHolderBalanceSol * LAMPORTS_PER_SOL
);

export const MIN_HOLDER_TOKEN_AMOUNT = Number(
  settings.holders.minHolderTokenAmount
);

export const DEV_WALLET_SECRET =
  settings.wallets.devWalletSecret ?? "<paste base58 secret>";

export const MINT_KEYPAIR_SECRET = settings.wallets.mintKeypairSecret ?? "";

export const TOKENS = settings.holders.tokens;

export const MAX_FETCH_HOLDERS = settings.holders.maxFetchHolders;

export const REFETCH_ALL = settings.holders.refetchAll;

export const HOLDER_BALANCE_BATCH_SIZE = settings.holders.balanceBatchSize;
export const HOLDER_BALANCE_DELAY_MS = settings.holders.balanceDelayMs;

export const BUYBACK_POLL_INTERVAL_MS = Number(
  settings.buyback.pollIntervalMs ?? 10000
);

export const BUYBACK_TRIGGER_LAMPORTS = Math.floor(
  Number(settings.buyback.triggerSol ?? 0.1) * LAMPORTS_PER_SOL
);

export const BUYBACK_SOL_CAP_LAMPORTS = Math.floor(
  Number(settings.buyback.solCap ?? 0.5) * LAMPORTS_PER_SOL
);

export const DISTRIBUTION_BATCH_SIZE = Number(
  settings.distribution.batchSize ?? 20
);

export const DISTRIBUTION_TARGETS = Number(
  settings.distribution.targetRecipients ?? 1000
);

export const DISTRIBUTION_FETCH_SIZE = Number(
  settings.distribution.fetchSize ?? 3000
);

export const MIN_DISTRIBUTABLE_TOKENS = BigInt(
  settings.distribution.minDistributableTokens ?? 1
);

export const loadDevWallet = () => loadKeypairFromSecret(DEV_WALLET_SECRET);

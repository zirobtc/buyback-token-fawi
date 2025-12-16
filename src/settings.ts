import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const SETTINGS_PATH = path.resolve(
  process.env.APP_SETTINGS_PATH ?? "./settings.local.json"
);

const parseNumber = (value: string | undefined, fallback: number) => {
  const num = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(num) ? num : fallback;
};

export type HolderSettings = {
  filePath: string;
  minHolderBalanceSol: number;
  minHolderTokenAmount: number;
  maxFetchHolders: number;
  balanceBatchSize: number;
  balanceDelayMs: number;
  refetchAll: boolean;
  tokens: string[];
};

export type DistributionSettings = {
  batchSize: number;
  minDistributableTokens: number;
  targetRecipients: number;
  fetchSize: number;
};

export type BuybackSettings = {
  pollIntervalMs: number;
  triggerSol: number;
  solCap: number;
};

export type WalletSettings = {
  devWalletSecret: string;
  mintKeypairSecret: string;
};

export type DefaultTradeSettings = {
  defaultBuySol: number;
  defaultSlippageBps: number;
};

export type AppSettings = {
  rpcEndpoint: string;
  holders: HolderSettings;
  distribution: DistributionSettings;
  buyback: BuybackSettings;
  wallets: WalletSettings;
  defaults: DefaultTradeSettings;
};

const ensureNumber = (value: unknown, fallback: number): number => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number(value)
      : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const normalizeSettings = (settings: AppSettings): AppSettings => {
  return {
    ...settings,
    holders: {
      ...settings.holders,
      minHolderBalanceSol: ensureNumber(
        settings.holders.minHolderBalanceSol,
        defaultSettings.holders.minHolderBalanceSol
      ),
      minHolderTokenAmount: ensureNumber(
        settings.holders.minHolderTokenAmount,
        defaultSettings.holders.minHolderTokenAmount
      ),
      maxFetchHolders: ensureNumber(
        settings.holders.maxFetchHolders,
        defaultSettings.holders.maxFetchHolders
      ),
      balanceBatchSize: ensureNumber(
        settings.holders.balanceBatchSize,
        defaultSettings.holders.balanceBatchSize
      ),
      balanceDelayMs: ensureNumber(
        settings.holders.balanceDelayMs,
        defaultSettings.holders.balanceDelayMs
      )
    },
    distribution: {
      ...settings.distribution,
      batchSize: ensureNumber(
        settings.distribution.batchSize,
        defaultSettings.distribution.batchSize
      ),
      targetRecipients: ensureNumber(
        settings.distribution.targetRecipients,
        defaultSettings.distribution.targetRecipients
      ),
      fetchSize: ensureNumber(
        settings.distribution.fetchSize,
        defaultSettings.distribution.fetchSize
      )
    },
    buyback: {
      ...settings.buyback,
      pollIntervalMs: ensureNumber(
        settings.buyback.pollIntervalMs,
        defaultSettings.buyback.pollIntervalMs
      ),
      triggerSol: ensureNumber(
        settings.buyback.triggerSol,
        defaultSettings.buyback.triggerSol
      ),
      solCap: ensureNumber(
        settings.buyback.solCap,
        defaultSettings.buyback.solCap
      )
    },
    defaults: {
      ...settings.defaults,
      defaultBuySol: ensureNumber(
        settings.defaults.defaultBuySol,
        defaultSettings.defaults.defaultBuySol
      ),
      defaultSlippageBps: ensureNumber(
        settings.defaults.defaultSlippageBps,
        defaultSettings.defaults.defaultSlippageBps
      )
    }
  };
};

const deepMerge = <T>(base: T, override?: Partial<T>): T => {
  if (!override) return base;
  const result: any = Array.isArray(base)
    ? [...(base as unknown[])]
    : { ...(base as Record<string, unknown>) };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = (result as Record<string, unknown>)[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(current, value as any);
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result as T;
};

const loadFileSettings = (): Partial<AppSettings> => {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return parsed ?? {};
  } catch (err) {
    console.warn(`Unable to load settings file at ${SETTINGS_PATH}:`, err);
    return {};
  }
};

const defaultSettings: AppSettings = {
  rpcEndpoint:
    process.env.RPC_ENDPOINT ?? "https://api.mainnet-beta.solana.com",
  holders: {
    filePath: process.env.HOLDERS_JSON_PATH ?? "./holders.json",
    minHolderBalanceSol: 5,
    minHolderTokenAmount: 0,
    maxFetchHolders: 5000,
    balanceBatchSize: 100,
    balanceDelayMs: 250,
    refetchAll: false,
    tokens: []
  },
  distribution: {
    batchSize: 20,
    minDistributableTokens: 1,
    targetRecipients: 1000,
    fetchSize: 3000
  },
  buyback: {
    pollIntervalMs: 10000,
    triggerSol: 0.1,
    solCap: 0.5
  },
  wallets: {
    devWalletSecret: "",
    mintKeypairSecret: ""
  },
  defaults: {
    defaultBuySol: parseNumber(process.env.DEFAULT_BUY_SOL, 1.5),
    defaultSlippageBps: parseNumber(process.env.DEFAULT_SLIPPAGE_BPS, 300)
  }
};

const fileSettings = loadFileSettings();

let currentSettings: AppSettings = normalizeSettings(
  deepMerge(defaultSettings, fileSettings)
);

export const getSettings = () => currentSettings;

export const updateSettings = (
  patch: Partial<AppSettings>,
  persist: boolean = false
) => {
  currentSettings = normalizeSettings(deepMerge(currentSettings, patch));
  if (persist) {
    saveSettings(currentSettings);
  }
  return currentSettings;
};

export const saveSettings = (settings: AppSettings = currentSettings) => {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
};

export const settingsFilePath = SETTINGS_PATH;

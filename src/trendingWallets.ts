import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs/promises";
import path from "path";
import {
  HOLDERS_JSON_PATH,
  MIN_HOLDER_BALANCE_LAMPORTS
} from "./config";
import { createConnection } from "./utils/solana";

type HolderRecord = {
  tokenAddress: string; // mint address
  holders: string[];
};

type HolderFileShape = HolderRecord[] | { tokens: HolderRecord[] };

const parsePublicKey = (value?: string) => {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
};

const loadHolderFile = async (
  filePath: string
): Promise<HolderRecord[]> => {
  try {
    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    const parsed = JSON.parse(raw) as HolderFileShape;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray((parsed as any).tokens)) {
      return (parsed as any).tokens;
    }
  } catch (err) {
    console.warn(`Unable to load holders file ${filePath}:`, err);
  }
  return [];
};

export const fetchHoldersForToken = async (
  tokenAddress: string,
  {
    maxHolders = 10000,
    filePath = HOLDERS_JSON_PATH,
    connection,
    minBalanceLamports = MIN_HOLDER_BALANCE_LAMPORTS
  }: {
    maxHolders?: number;
    filePath?: string;
    connection?: Connection;
    minBalanceLamports?: number;
  } = {}
) => {
  const records = await loadHolderFile(filePath);
  const record =
    records.find(
      (item) =>
        item.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase()
    ) ?? null;

  if (!record) return [];

  const conn = connection ?? createConnection();
  const dedupe = new Set<string>();
  const wallets: PublicKey[] = [];
  for (const holder of record.holders.slice(0, maxHolders)) {
    const key = parsePublicKey(holder);
    if (!key) continue;
    const base = key.toBase58();
    if (dedupe.has(base)) continue;
    dedupe.add(base);
    wallets.push(key);
  }
  return wallets;
};

export const fetchRecipientWallets = async ({
  filePath = HOLDERS_JSON_PATH,
  maxHoldersPerToken = 10000,
  maxRecipients = 100,
  connection,
  minBalanceLamports = MIN_HOLDER_BALANCE_LAMPORTS
}: {
  filePath?: string;
  maxHoldersPerToken?: number;
  maxRecipients?: number;
  connection?: Connection;
  minBalanceLamports?: number;
} = {}) => {
  const records = await loadHolderFile(filePath);
  const conn = connection ?? createConnection();
  const dedupe = new Set<string>();
  const recipients: PublicKey[] = [];

  for (const record of records) {
    if (!record?.tokenAddress || !Array.isArray(record.holders)) continue;
    if (recipients.length >= maxRecipients) break;

    for (const holder of record.holders.slice(0, maxHoldersPerToken)) {
      const key = parsePublicKey(holder);
      if (!key) continue;
      const base = key.toBase58();
      if (dedupe.has(base)) continue;
      dedupe.add(base);
      recipients.push(key);
      if (recipients.length >= maxRecipients) break;
    }
  }

  console.log(
    `[recipients] Fetched ${recipients.length} unique recipients (max ${maxRecipients}) from ${records.length} token entries`
  );
  return recipients;
};

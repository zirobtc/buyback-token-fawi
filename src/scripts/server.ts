import http from "http";
import fs from "fs/promises";
import path from "path";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { refreshTokenHolders } from "../services/holders";
import { distributionController } from "../services/distributionController";
import { getSettings, settingsFilePath, updateSettings } from "../settings";
import { MINT_KEYPAIR_SECRET } from "../config";
import { loadKeypairFromSecret } from "../utils/solana";

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const STATE_PATH =
  process.env.DISTRIBUTION_STATE_PATH ?? "./distribution-state.json";

const sendJson = (
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>
) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

const parseBody = (req: http.IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const parseNumber = (value: unknown) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const parsePublicKey = (value: unknown) => {
  if (!value) return null;
  try {
    return new PublicKey(String(value));
  } catch {
    return null;
  }
};

const loadHolderTokens = async (filePath: string): Promise<string[]> => {
  try {
    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((r) => (r?.tokenAddress ? String(r.tokenAddress) : null))
        .filter(Boolean) as string[];
    }
    if (parsed && Array.isArray((parsed as any)?.tokens)) {
      return (parsed as any).tokens
        .map((r: any) => (r?.tokenAddress ? String(r.tokenAddress) : null))
        .filter(Boolean);
    }
  } catch {
    // ignore
  }
  return [];
};

const loadHolderSummary = async (
  filePath: string
): Promise<{ tokenCount: number; totalHolderEntries: number; uniqueHolders: number }> => {
  try {
    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tokens)
        ? parsed.tokens
        : [];
    let totalHolderEntries = 0;
    const uniq = new Set<string>();
    records.forEach((r: any) => {
      const holders = Array.isArray(r?.holders) ? r.holders : [];
      totalHolderEntries += holders.length;
      holders.forEach((h) => {
        if (typeof h === "string") {
          uniq.add(h);
        }
      });
    });
    return {
      tokenCount: records.length,
      totalHolderEntries,
      uniqueHolders: uniq.size
    };
  } catch {
    return { tokenCount: 0, totalHolderEntries: 0, uniqueHolders: 0 };
  }
};

const deriveMintPublicKey = (): string | null => {
  try {
    if (!MINT_KEYPAIR_SECRET) return null;
    const kp = loadKeypairFromSecret(MINT_KEYPAIR_SECRET);
    return kp.publicKey.toBase58();
  } catch {
    return null;
  }
};

const loadSentCount = async (mint: string | null): Promise<number> => {
  if (!mint) return 0;
  try {
    const raw = await fs.readFile(path.resolve(STATE_PATH), "utf8");
    const parsed = JSON.parse(raw);
    const sent = parsed?.sent ?? {};
    const arr = Array.isArray(sent?.[mint]) ? sent[mint] : [];
    return arr.length;
  } catch {
    return 0;
  }
};

const toNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const { method, url } = req;

  try {
    if (method === "GET" && url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/settings/update") {
      const body = await parseBody(req);
      const patch: any = {};

      const buyback: any = {};
      const pollIntervalMs = toNumber(body?.pollIntervalMs);
      const triggerSol = toNumber(body?.triggerSol);
      const solCap = toNumber(body?.solCap);
      if (pollIntervalMs !== undefined) buyback.pollIntervalMs = pollIntervalMs;
      if (triggerSol !== undefined) buyback.triggerSol = triggerSol;
      if (solCap !== undefined) buyback.solCap = solCap;
      if (Object.keys(buyback).length) patch.buyback = buyback;

      const distribution: any = {};
      const batchSize = toNumber(body?.batchSize);
      const targetRecipients = toNumber(body?.targetRecipients);
      const recipientFetchSize = toNumber(body?.recipientFetchSize);
      if (batchSize !== undefined) distribution.batchSize = batchSize;
      if (targetRecipients !== undefined)
        distribution.targetRecipients = targetRecipients;
      if (recipientFetchSize !== undefined)
        distribution.fetchSize = recipientFetchSize;
      if (Object.keys(distribution).length) patch.distribution = distribution;

      const defaults: any = {};
      const slippageBps = toNumber(body?.slippageBps);
      if (slippageBps !== undefined) defaults.defaultSlippageBps = slippageBps;
      if (Object.keys(defaults).length) patch.defaults = defaults;

      const holders: any = {};
      if (Array.isArray(body?.tokens)) {
        holders.tokens = body.tokens.map((t: any) => String(t)).filter(Boolean);
      }
      const limit = toNumber(body?.limit);
      const balanceBatchSize = toNumber(body?.balanceBatchSize);
      const minTokenAmount = toNumber(body?.minTokenAmount);
      const minHolderBalanceSol = toNumber(body?.minHolderBalanceSol);
      if (limit !== undefined) holders.maxFetchHolders = limit;
      if (balanceBatchSize !== undefined)
        holders.balanceBatchSize = balanceBatchSize;
      if (minTokenAmount !== undefined) holders.minHolderTokenAmount = minTokenAmount;
      if (minHolderBalanceSol !== undefined)
        holders.minHolderBalanceSol = minHolderBalanceSol;
      if (body?.refetchExisting !== undefined)
        holders.refetchAll = body.refetchExisting === true;
      if (Object.keys(holders).length) patch.holders = holders;

      const updated = updateSettings(patch, true);
      const holderTokens = await loadHolderTokens(updated.holders.filePath);
      const mintPublicKey = deriveMintPublicKey();
      const holderSummary = await loadHolderSummary(updated.holders.filePath);
      const sentCount = await loadSentCount(mintPublicKey);

      sendJson(res, 200, {
        settings: updated,
        settingsFilePath,
        holderTokens,
        mintPublicKey,
        holderSummary,
        sentCount
      });
      return;
    }

    if (method === "GET" && url === "/settings") {
      const settings = getSettings();
      const holderTokens = await loadHolderTokens(settings.holders.filePath);
      const mintPublicKey = deriveMintPublicKey();
      const holderSummary = await loadHolderSummary(settings.holders.filePath);
      const sentCount = await loadSentCount(mintPublicKey);
      sendJson(res, 200, {
        settings,
        settingsFilePath,
        holderTokens,
        mintPublicKey,
        holderSummary,
        sentCount
      });
      return;
    }

    if (method === "POST" && url === "/holders/refresh") {
      const body = await parseBody(req);
      console.log("[api] /holders/refresh", body ?? {});
      const tokens = Array.isArray(body?.tokens)
        ? body.tokens.map((t: any) => String(t)).filter(Boolean)
        : undefined;
      const refetchExisting = body?.refetchExisting === true;
      const limit = parseNumber(body?.limit);
      const minTokenAmount = parseNumber(body?.minTokenAmount);
      const minHolderBalanceLamports =
        body?.minHolderBalanceSol !== undefined
          ? Math.floor(Number(body.minHolderBalanceSol) * LAMPORTS_PER_SOL)
          : undefined;
      const balanceBatchSize = parseNumber(body?.balanceBatchSize);
      const balanceDelayMs = parseNumber(body?.balanceDelayMs);

      // Kick off refresh in the background to avoid request timeouts.
      (async () => {
        try {
          const result = await refreshTokenHolders({
            tokens,
            limit,
            refetchExisting,
            minTokenAmount,
            minHolderBalanceLamports,
            balanceBatchSize,
            balanceDelayMs
          });
          console.log("[holders] background refresh completed", {
            tokensPlanned: result.tokensPlanned,
            refreshed: result.refreshed.map((r) => ({
              tokenAddress: r.tokenAddress,
              fetched: r.fetched,
              eligibleOwners: r.eligibleOwners,
              status: r.status
            }))
          });
        } catch (err) {
          console.error("[holders] background refresh failed", err);
        }
      })();

      sendJson(res, 202, {
        started: true,
        tokens,
        limit,
        refetchExisting,
        minTokenAmount,
        minHolderBalanceSol: body?.minHolderBalanceSol,
        balanceBatchSize,
        balanceDelayMs,
        note: "Holder refresh started in background; check server logs for progress."
      });
      return;
    }

    if (method === "GET" && url === "/distribution/status") {
      sendJson(res, 200, { status: distributionController.status() });
      return;
    }

    if (method === "POST" && url === "/distribution/start") {
      const body = await parseBody(req);
      const mint = parsePublicKey(body?.mint);
      const triggerLamports =
        body?.triggerSol !== undefined
          ? Math.floor(Number(body.triggerSol) * LAMPORTS_PER_SOL)
          : undefined;
      const capLamports =
        body?.solCap !== undefined
          ? Math.floor(Number(body.solCap) * LAMPORTS_PER_SOL)
          : undefined;
      const status = await distributionController.start({
        mint: mint ?? undefined,
        pollIntervalMs: parseNumber(body?.pollIntervalMs),
        buybackTriggerLamports: triggerLamports,
        buybackSolCapLamports: capLamports,
        batchSize: parseNumber(body?.batchSize),
        slippageBps: parseNumber(body?.slippageBps)
      });
      console.log("[api] /distribution/start", {
        mint: mint?.toBase58(),
        pollIntervalMs: body?.pollIntervalMs,
        triggerSol: body?.triggerSol,
        solCap: body?.solCap,
        batchSize: body?.batchSize,
        slippageBps: body?.slippageBps
      });
      sendJson(res, 200, { status });
      return;
    }

    if (method === "POST" && url === "/distribution/pause") {
      sendJson(res, 200, { status: distributionController.pause() });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("API request failed", err);
    sendJson(res, 500, {
      error: (err as Error)?.message ?? "Internal server error"
    });
  }
});

server.listen(PORT, () => {
  console.log(`Control API listening on port ${PORT}`);
});

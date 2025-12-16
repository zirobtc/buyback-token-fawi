import { Keypair, PublicKey } from "@solana/web3.js";
import { runDistributionLoop, DistributionOptions } from "../distributionLoop";
import {
  loadDevWallet,
  MINT_KEYPAIR_SECRET
} from "../config";
import { loadKeypairFromSecret } from "../utils/solana";
import { PauseSwitch } from "../utils/control";

export type DistributionStatus = {
  running: boolean;
  paused: boolean;
  mint?: string;
  startedAt?: string;
  lastError?: string | null;
};

export class DistributionController {
  private pauseSwitch = new PauseSwitch();
  private abortController: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private startedAt: Date | null = null;
  private currentMint: PublicKey | null = null;
  private devWallet: Keypair | null = null;

  private resolveMint(provided?: PublicKey) {
    if (provided) return provided;
    if (!MINT_KEYPAIR_SECRET) {
      throw new Error("MINT_KEYPAIR_SECRET is not configured");
    }
    return loadKeypairFromSecret(MINT_KEYPAIR_SECRET).publicKey;
  }

  private ensureDevWallet() {
    if (!this.devWallet) {
      this.devWallet = loadDevWallet();
    }
    return this.devWallet;
  }

  status(): DistributionStatus {
    return {
      running: !!this.runPromise,
      paused: this.pauseSwitch.paused,
      mint: this.currentMint?.toBase58(),
      startedAt: this.startedAt?.toISOString(),
      lastError: this.lastError
    };
  }

  async start(options: Partial<DistributionOptions> & { mint?: PublicKey } = {}) {
    if (this.runPromise) {
      return this.status();
    }

    const mint = this.resolveMint(options.mint);
    this.currentMint = mint;
    this.pauseSwitch.resume();
    this.abortController = new AbortController();
    this.startedAt = new Date();
    this.lastError = null;
    const devWallet = options.devWallet ?? this.ensureDevWallet();

    this.runPromise = runDistributionLoop({
      ...options,
      mint,
      devWallet,
      pauseSwitch: this.pauseSwitch,
      abortSignal: this.abortController.signal
    }).catch((err) => {
      this.lastError = (err as Error)?.message ?? String(err);
    }).finally(() => {
      this.runPromise = null;
      this.abortController = null;
      this.currentMint = null;
    });

    return this.status();
  }

  pause() {
    this.pauseSwitch.pause();
    return this.status();
  }

  resume() {
    this.pauseSwitch.resume();
    return this.status();
  }

  async stop() {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
    return this.status();
  }

  async waitForCompletion() {
    if (this.runPromise) {
      await this.runPromise;
    }
  }
}

export const distributionController = new DistributionController();

import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SendOptions,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  Mint
} from "@solana/spl-token";
import bs58 from "bs58";

const DEFAULT_RPC_ENDPOINT =
  process.env.RPC_ENDPOINT ?? "https://api.mainnet-beta.solana.com";

export const createConnection = (
  endpoint: string = DEFAULT_RPC_ENDPOINT,
  commitment: Commitment = "confirmed"
) => new Connection(endpoint, commitment);

export const loadKeypairFromSecret = (secret: string): Keypair => {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const arr = Uint8Array.from(JSON.parse(trimmed));
    return Keypair.fromSecretKey(arr);
  }
  const bytes = bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
};

export const ataFor = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true);

export const fetchMint = async (
  connection: Connection,
  mint: PublicKey,
  programId?: PublicKey
) => getMint(connection, mint, undefined, programId);

export const fetchMintWithProgram = async (
  connection: Connection,
  mint: PublicKey
): Promise<{ mint: Mint; programId: PublicKey }> => {
  let lastError: unknown;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const info = await fetchMint(connection, mint, programId);
      return { mint: info, programId };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`Unable to fetch mint ${mint.toBase58()}`);
};

export const mintDecimals = async (connection: Connection, mint: PublicKey) => {
  const { mint: info } = await fetchMintWithProgram(connection, mint);
  return info.decimals;
};

export const sendTx = async (
  connection: Connection,
  transaction: Transaction | VersionedTransaction,
  signers: Keypair[] = [],
  options?: SendOptions
) => {
  if ("version" in transaction) {
    return connection.sendTransaction(transaction, options);
  }
  return connection.sendTransaction(transaction, signers, options);
};

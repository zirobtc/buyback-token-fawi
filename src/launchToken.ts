import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction
} from "@solana/web3.js";
import BN from "bn.js";
import {
  PumpSdk,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount
} from "@pump-fun/pump-sdk";
import {
  DEFAULT_BUY_LAMPORTS,
  DEFAULT_SLIPPAGE_BPS,
  TOKEN_METADATA,
  loadDevWallet
} from "./config";
import { ataFor, createConnection, loadKeypairFromSecret } from "./utils/solana";

export type LaunchParams = {
  connection?: Connection;
  devWallet?: Keypair;
  mintKeypair?: Keypair;
  name?: string;
  symbol?: string;
  uri?: string;
  decimals?: number;
  buyAmountLamports?: number;
  slippageBps?: number;
};

const loadMintKeypairFromEnv = (): Keypair => {
  const secret = process.env.MINT_KEYPAIR_SECRET ?? process.env.MINT_SECRET;
  if (!secret) {
    throw new Error(
      "MINT_KEYPAIR_SECRET (or MINT_SECRET) is required to run launchToken; provide the vanity mint secret."
    );
  }
  return loadKeypairFromSecret(secret);
};

export const createAndBuy = async (
  params: LaunchParams = {}
): Promise<{
  signature: string;
  mint: PublicKey;
  devAta: PublicKey;
}> => {
  const connection = params.connection ?? createConnection();
  const devWallet = params.devWallet ?? loadDevWallet();
  const mintKeypair = params.mintKeypair ?? loadMintKeypairFromEnv();

  const offlineSdk = new PumpSdk();
  const onlineSdk = new OnlinePumpSdk(connection);
  const buyLamports = params.buyAmountLamports ?? DEFAULT_BUY_LAMPORTS;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const mint = mintKeypair.publicKey;
  const devAta = ataFor(mint, devWallet.publicKey);
  const global = await onlineSdk.fetchGlobal();
  const solAmount = new BN(buyLamports);
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: null,
    mintSupply: null,
    bondingCurve: null,
    amount: solAmount
  });

  const createArgs: any = {
    global,
    mint,
    name: params.name ?? TOKEN_METADATA.name,
    symbol: params.symbol ?? TOKEN_METADATA.symbol,
    uri: params.uri ?? TOKEN_METADATA.uri,
    creator: devWallet.publicKey,
    user: devWallet.publicKey,
    solAmount,
    amount
  };
  if (slippageBps !== undefined) {
    createArgs.slippage = slippageBps;
  }

  const instructions = await offlineSdk.createAndBuyInstructions(createArgs);

  const recent = await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: devWallet.publicKey,
    ...recent
  });
  tx.add(...instructions);
  tx.partialSign(mintKeypair);

  const signature = await connection.sendTransaction(tx, [devWallet, mintKeypair], {
    skipPreflight: false
  });

  return { signature, mint, devAta };
};

export const demo = async () => {
  const { signature, mint } = await createAndBuy({
    buyAmountLamports: 1.5 * LAMPORTS_PER_SOL
  });
  console.log("Create+buy signature", signature);
  console.log("Mint", mint.toBase58());
};

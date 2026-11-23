"use client";

import bs58 from "bs58";
import { post } from "./api";

interface InjectedWallet {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

/** Phantom or Solflare injected provider. The panel only ever asks for a message signature. */
export function findWallet(): InjectedWallet | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: InjectedWallet }; solana?: InjectedWallet; solflare?: InjectedWallet };
  return w.phantom?.solana ?? w.solana ?? w.solflare ?? null;
}

/** Sign-In With Solana: get a nonce, sign the message (no transaction, no fee), verify. */
export async function signIn(): Promise<void> {
  const wallet = findWallet();
  if (!wallet) throw new Error("Phantom ya da Solflare bulunamadı. Tarayıcı eklentisini kurup sayfayı yenileyin.");
  const { publicKey } = await wallet.connect();
  const address = publicKey.toString();
  const { nonce, message } = await post<{ nonce: string; message: string }>("/v1/auth/nonce", { wallet: address });
  const signed = await wallet.signMessage(new TextEncoder().encode(message), "utf8");
  const signature = signed instanceof Uint8Array ? signed : signed.signature;
  await post("/v1/auth/verify", { wallet: address, nonce, signature: bs58.encode(signature) });
}

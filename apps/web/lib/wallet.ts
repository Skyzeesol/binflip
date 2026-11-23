"use client";

import bs58 from "bs58";
import { post } from "./api";

/**
 * Wallet discovery via the Wallet Standard (Jupiter, Phantom, Solflare, Backpack…),
 * implemented directly so the panel needs no wallet-adapter dependency. Older
 * injected providers (window.phantom.solana etc.) are a fallback. The panel only
 * ever asks for a message signature: never a transaction.
 */

interface StdAccount {
  address: string;
  publicKey: Uint8Array;
}

interface StdWallet {
  name: string;
  icon: string;
  accounts: readonly StdAccount[];
  features: Record<string, unknown>;
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StdAccount[] }>;
}

interface SignMessageFeature {
  signMessage(...inputs: { account: StdAccount; message: Uint8Array }[]): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

interface InjectedWallet {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

export interface WalletOption {
  name: string;
  icon: string | null;
  /** Returns the address and a function that signs a message with it. */
  open(): Promise<{ address: string; sign(message: Uint8Array): Promise<Uint8Array> }>;
}

const registered: StdWallet[] = [];
const listeners = new Set<() => void>();
let started = false;

function startDiscovery() {
  if (started || typeof window === "undefined") return;
  started = true;
  const api = {
    register(...wallets: StdWallet[]) {
      for (const w of wallets) if (!registered.includes(w)) registered.push(w);
      listeners.forEach((l) => l());
      return () => {};
    },
  };
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    (e as CustomEvent<(a: typeof api) => void>).detail(api);
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
}

/** Notifies when a wallet registers late (extensions inject after page load). */
export function onWalletsChanged(cb: () => void): () => void {
  startDiscovery();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const PREFERRED = ["jupiter", "phantom", "solflare", "backpack"];

export function listWallets(): WalletOption[] {
  startDiscovery();
  const out: WalletOption[] = [];
  for (const w of registered) {
    const connect = w.features["standard:connect"] as ConnectFeature | undefined;
    const sign = w.features["solana:signMessage"] as SignMessageFeature | undefined;
    if (!connect || !sign) continue;
    out.push({
      name: w.name,
      icon: w.icon,
      async open() {
        const { accounts } = await connect.connect();
        const account = accounts[0] ?? w.accounts[0];
        if (!account) throw new Error(`${w.name}: hesap seçilmedi`);
        return {
          address: account.address,
          async sign(message) {
            const [res] = await sign.signMessage({ account, message });
            if (!res) throw new Error(`${w.name}: imza alınamadı`);
            return res.signature;
          },
        };
      },
    });
  }
  if (out.length === 0) {
    const legacy = injected();
    if (legacy) {
      out.push({
        name: "Cüzdan",
        icon: null,
        async open() {
          const { publicKey } = await legacy.connect();
          return {
            address: publicKey.toString(),
            async sign(message) {
              const s = await legacy.signMessage(message, "utf8");
              return s instanceof Uint8Array ? s : s.signature;
            },
          };
        },
      });
    }
  }
  const rank = (n: string) => {
    const i = PREFERRED.findIndex((p) => n.toLowerCase().includes(p));
    return i === -1 ? PREFERRED.length : i;
  };
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

function injected(): InjectedWallet | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    jupiter?: { solana?: InjectedWallet } & Partial<InjectedWallet>;
    phantom?: { solana?: InjectedWallet };
    solana?: InjectedWallet;
    solflare?: InjectedWallet;
  };
  return w.jupiter?.solana ?? w.phantom?.solana ?? w.solana ?? w.solflare ?? null;
}

/** Sign-In With Solana: get a nonce, sign the message (no transaction, no fee), verify. */
export async function signIn(wallet: WalletOption): Promise<void> {
  const { address, sign } = await wallet.open();
  const { nonce, message } = await post<{ nonce: string; message: string }>("/v1/auth/nonce", { wallet: address, origin: window.location.origin });
  const signature = await sign(new TextEncoder().encode(message));
  await post("/v1/auth/verify", { wallet: address, nonce, signature: bs58.encode(signature) });
}

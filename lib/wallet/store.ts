/**
 * Wallet store — framework-free. No React, no module-scope `window`.
 *
 * The snapshot is replaced wholesale on every transition and keeps a
 * stable reference between transitions, which is exactly what
 * `useSyncExternalStore` requires to avoid an infinite re-render.
 */

import type { providers } from "ethers";
import { toKuruGridError } from "../constants";
import {
  checkAndSwitchNetwork,
  connectWallet,
  type WalletConnection,
} from "../kuruClient";
import type { WalletSnapshot } from "./types";

const DISCONNECTED: WalletSnapshot = {
  status: "disconnected",
  account: null,
  error: null,
  provider: null,
};

let snapshot: WalletSnapshot = DISCONNECTED;
const listeners = new Set<() => void>();
let connecting = false;
let detachChainEvents: (() => void) | null = null;

export function getSnapshot(): WalletSnapshot {
  return snapshot;
}

/** SSR/first-client-render must agree: always the disconnected view. */
export function getServerSnapshot(): WalletSnapshot {
  return DISCONNECTED;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(next: WalletSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Move the chain-event wiring out of the component tree. */
function subscribeChainEvents(): void {
  if (detachChainEvents !== null) return; // never double-subscribe
  if (typeof window === "undefined" || !window.ethereum) return;
  const injected = window.ethereum;

  const onAccountsChanged = (...args: unknown[]): void => {
    const accounts = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
    const first = accounts[0];
    if (typeof first === "string" && first !== "") {
      emit({
        ...snapshot,
        status: "connected",
        account: {
          address: first,
          chainId: snapshot.account?.chainId ?? 0,
        },
        error: null,
      });
    } else {
      // Wallet disconnected/locked — drop the whole session.
      emit({ ...DISCONNECTED });
    }
  };

  const onChainChanged = (...args: unknown[]): void => {
    const raw = args[0];
    if (typeof raw !== "string") return;
    const next = Number.parseInt(raw, 16);
    if (snapshot.account === null) return;
    emit({
      ...snapshot,
      account: {
        ...snapshot.account,
        chainId: Number.isFinite(next) ? next : snapshot.account.chainId,
      },
    });
  };

  injected.on?.("accountsChanged", onAccountsChanged);
  injected.on?.("chainChanged", onChainChanged);

  detachChainEvents = (): void => {
    injected.removeListener?.("accountsChanged", onAccountsChanged);
    injected.removeListener?.("chainChanged", onChainChanged);
    detachChainEvents = null;
  };
}

export async function connect(): Promise<void> {
  if (connecting) return; // synchronous-entry guard, mirrors deployingRef
  connecting = true;
  emit({ ...snapshot, status: "connecting", error: null });
  try {
    const wallet: WalletConnection = await connectWallet();
    const check = await checkAndSwitchNetwork();
    emit({
      status: "connected",
      account: { address: wallet.address, chainId: check.chainId },
      error: null,
      provider: wallet.provider,
    });
    subscribeChainEvents();
  } catch (cause) {
    // 4001 is never retried and never rendered as a crash — just an
    // error status whose message the rose banner shows.
    emit({
      ...snapshot,
      status: "error",
      error: toKuruGridError(cause, "Wallet connection failed.").message,
    });
  } finally {
    connecting = false;
  }
}

export function disconnect(): void {
  detachChainEvents?.();
  emit({ ...DISCONNECTED });
}

export function clearError(): void {
  if (snapshot.error === null) return;
  emit({
    ...snapshot,
    error: null,
    status: snapshot.account !== null ? "connected" : "disconnected",
  });
}

export function getProvider(): providers.Web3Provider | null {
  return snapshot.provider;
}

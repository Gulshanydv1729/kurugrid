"use client";

import { useMemo, useSyncExternalStore } from "react";
import * as store from "./store";
import type { WalletActions, WalletSnapshot } from "./types";

/** Module-level, stable — actions are never recreated per render. */
const ACTIONS: WalletActions = {
  connect: store.connect,
  disconnect: store.disconnect,
  clearError: store.clearError,
  getProvider: store.getProvider,
};

export function useWallet(): WalletSnapshot & WalletActions {
  const snap = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return useMemo(() => ({ ...snap, ...ACTIONS }), [snap]);
}

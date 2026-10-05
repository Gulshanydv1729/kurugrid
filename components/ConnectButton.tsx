"use client";

import { Wallet } from "lucide-react";
import { useWallet } from "@/lib/wallet";

/**
 * Extraction of the old inline header button. Consumes the wallet
 * store directly — no address/chainId props threaded through.
 */
export function ConnectButton() {
  const wallet = useWallet();
  const address = wallet.account?.address ?? null;

  return (
    <button
      type="button"
      onClick={() => void wallet.connect()}
      disabled={wallet.status === "connecting"}
      className="flex items-center gap-2 rounded-md border border-violet-500/50 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-300 transition-colors hover:bg-violet-500/20 disabled:cursor-wait disabled:opacity-60"
    >
      <Wallet className="h-3.5 w-3.5" />
      {wallet.status === "connecting"
        ? "Connecting…"
        : address !== null
          ? `${address.slice(0, 6)}…${address.slice(-4)}`
          : "Connect"}
    </button>
  );
}

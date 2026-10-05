import type { providers } from "ethers";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

export interface WalletAccount {
  readonly address: string;
  readonly chainId: number;
}

export interface WalletSnapshot {
  readonly status: WalletStatus;
  readonly account: WalletAccount | null;
  readonly error: string | null;
  readonly provider: providers.Web3Provider | null;
}

export interface WalletActions {
  connect(): Promise<void>;
  disconnect(): void;
  clearError(): void;
  getProvider(): providers.Web3Provider | null;
}

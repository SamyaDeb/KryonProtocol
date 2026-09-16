"use client";

import { create } from "zustand";

interface WalletState {
  address: string | null;
  connected: boolean;
  wrongNetwork: boolean;
  connecting: boolean;
  setAddress: (address: string | null) => void;
  setConnected: (v: boolean) => void;
  setWrongNetwork: (v: boolean) => void;
  setConnecting: (v: boolean) => void;
  disconnect: () => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  address: null,
  connected: false,
  wrongNetwork: false,
  connecting: false,
  setAddress: (address) => set({ address }),
  setConnected: (connected) => set({ connected }),
  setWrongNetwork: (wrongNetwork) => set({ wrongNetwork }),
  setConnecting: (connecting) => set({ connecting }),
  disconnect: () => set({ address: null, connected: false, wrongNetwork: false }),
}));

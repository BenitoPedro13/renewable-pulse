"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createLiveStore, type LiveStore } from "@/stores/live-store";

type LiveStoreApi = ReturnType<typeof createLiveStore>;

const LiveStoreContext = createContext<LiveStoreApi | undefined>(undefined);

export function LiveStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createLiveStore);
  return <LiveStoreContext.Provider value={store}>{children}</LiveStoreContext.Provider>;
}

/** Base selector access to the live store — not exported outside providers/hooks; every consumer goes through an abstracted hook in src/hooks/ instead. */
export function useLiveStore<T>(selector: (store: LiveStore) => T): T {
  const context = useContext(LiveStoreContext);
  if (!context) throw new Error("useLiveStore must be used within LiveStoreProvider");
  return useStore(context, selector);
}

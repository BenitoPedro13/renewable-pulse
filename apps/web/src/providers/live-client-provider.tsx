"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LiveClient } from "@/lib/live-client";
import { LiveStoreProvider, useLiveStore } from "@/providers/live-store-provider";

const LiveClientContext = createContext<LiveClient | undefined>(undefined);

function liveWebSocketUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
  return `${base.replace(/^http/, "ws").replace(/\/$/, "")}/live`;
}

/** Wires a LiveClient's handlers to the live Zustand store's actions. A real useEffect (synchronizing with an external system — CLAUDE.md's "Rendering & effects conventions"), not a general-purpose effect. */
function LiveClientConnector({ children }: { children: ReactNode }) {
  const setStatus = useLiveStore((s) => s.setStatus);
  const recordHeartbeat = useLiveStore((s) => s.recordHeartbeat);
  const recordReading = useLiveStore((s) => s.recordReading);
  const [client] = useState(
    () =>
      new LiveClient(liveWebSocketUrl(), {
        onStatusChange: setStatus,
        onHeartbeat: recordHeartbeat,
        onReading: recordReading,
      }),
  );

  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  return <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  return (
    <LiveStoreProvider>
      <LiveClientConnector>{children}</LiveClientConnector>
    </LiveStoreProvider>
  );
}

/** The stable LiveClient instance (opens/closes/reconnects the socket) — not its status, which lives in the Zustand store instead. */
export function useLiveClient(): LiveClient {
  const context = useContext(LiveClientContext);
  if (!context) throw new Error("useLiveClient must be used within LiveProvider");
  return context;
}

import { Suspense, type ReactNode } from "react";
import { OwnedConnectionStatus } from "../../features/device-binding/owned-connection-status";
import { ConnectionStatusBar } from "../../features/device-binding/connection-status-bar";
import { unavailableConnectionSnapshot } from "../../features/device-binding/connection-presence";
import { ConnectionNavigationProvider } from "../../features/room-access/chat-shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ConnectionNavigationProvider
      connection={
        <Suspense fallback={<ConnectionStatusBar snapshot={unavailableConnectionSnapshot(null)} />}>
          <OwnedConnectionStatus />
        </Suspense>
      }
    >
      {children}
    </ConnectionNavigationProvider>
  );
}

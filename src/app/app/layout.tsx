import { Suspense, type ReactNode } from "react";
import { OwnedConnectionStatus } from "../../features/device-binding/owned-connection-status";
import { ConnectionStatusBar } from "../../features/device-binding/connection-status-bar";
import { unavailableConnectionSnapshot } from "../../features/device-binding/connection-presence";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden">
      <Suspense fallback={<ConnectionStatusBar snapshot={unavailableConnectionSnapshot(null)} />}>
        <OwnedConnectionStatus />
      </Suspense>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto [&>main]:h-full [&>main]:min-h-0">
        {children}
      </div>
    </div>
  );
}

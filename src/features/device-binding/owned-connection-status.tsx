import "server-only";
import { requestClient } from "../../lib/supabase/server";
import { currentUser } from "../room-access/access-service";
import { ownedConnections } from "./service";
import {
  connectionSnapshot,
  unavailableConnectionSnapshot,
  type ConnectionSnapshot,
} from "./connection-presence";
import { ConnectionStatusBar } from "./connection-status-bar";

export async function OwnedConnectionStatus() {
  let snapshot: ConnectionSnapshot;
  try {
    const { client, hasAuthCookies } = await requestClient();
    if (!hasAuthCookies) return null;
    await currentUser(client);
    const owned = await ownedConnections(client);
    snapshot = connectionSnapshot(owned, new Date().toISOString());
  } catch {
    snapshot = unavailableConnectionSnapshot(new Date().toISOString());
  }
  return <ConnectionStatusBar snapshot={snapshot} />;
}

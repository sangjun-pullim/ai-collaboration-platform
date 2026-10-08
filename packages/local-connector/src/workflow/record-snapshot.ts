import type { RuntimeRecord } from "../runtime-contracts.ts";

const ownedRecords = new WeakSet<RuntimeRecord>();

function freezeTree(value: unknown, visited: WeakSet<object>) {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  for (const child of Object.values(value)) freezeTree(child, visited);
  Object.freeze(value);
}

/** Detach external aliases before persistence; only this module can mark an owned snapshot. */
export function ownRuntimeRecord(record: RuntimeRecord): RuntimeRecord {
  if (ownedRecords.has(record)) return record;
  const snapshot = structuredClone(record);
  freezeTree(snapshot, new WeakSet());
  ownedRecords.add(snapshot);
  return snapshot;
}

export function isOwnedRuntimeRecord(record: RuntimeRecord): boolean {
  return ownedRecords.has(record);
}

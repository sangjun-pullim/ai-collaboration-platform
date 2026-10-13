import type { ConnectorState } from "../state-store.ts";

/** Eligibility only; scope, pending work, runtime evidence and consent remain caller guards. */
export function isFreshApprovalEligible(owner: ConnectorState): boolean {
  const expiry = Date.parse(owner.credentialExpiresAt ?? "");
  return (
    !!owner.credential &&
    Number.isFinite(expiry) &&
    (owner.status === "disconnected" || (owner.status === "connected" && expiry <= Date.now()))
  );
}

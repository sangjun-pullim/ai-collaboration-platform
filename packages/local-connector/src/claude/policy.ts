import { RuntimeError, type OwnedContext, type RuntimeSettings } from "../runtime-contracts.ts";
import type { Launch } from "./transport.ts";

/** Created by reviewed native admission, never accepted from web, CLI flags or environment. */
export interface ClaudePolicy {
  readonly version: string;
  readonly fingerprint: string;
  admit(root: string, check: () => void): Promise<void>;
  assertLive(root: string, check: () => void): void;
  launch(
    context: OwnedContext,
    settings: RuntimeSettings | null,
    tools: readonly string[],
    resume: boolean,
  ): Launch;
}

export function requireClaudePolicy(policy: ClaudePolicy | undefined): ClaudePolicy {
  if (
    !policy ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(policy.version) ||
    !/^[a-f0-9]{64}$/.test(policy.fingerprint)
  )
    throw new RuntimeError("POLICY_UNCONFIRMED");
  return policy;
}

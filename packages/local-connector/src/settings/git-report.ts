import { CentralClient } from "../central-client.ts";
import type { StateStore } from "../state-store.ts";
import { RuntimeFilePolicy } from "../runtime-file-policy.ts";
import { repositoryMode } from "../workspace/repository-access.ts";
import type { OwnedContext } from "../runtime-contracts.ts";
import { stableJson, RuntimeError } from "../runtime-contracts.ts";
import { collectSourceObservation } from "../workflow/source-snapshot.ts";
import type { SettingsStore, SettingsState } from "./store.ts";

type CurrentSettings = Pick<SettingsStore, "read" | "generationStore">;
type ObservationOptions = {
  observe?: typeof collectSourceObservation;
  fetcher?: typeof fetch;
};
function idle(state: SettingsState | undefined): state is SettingsState {
  const journal = state?.journal;
  return (
    !!state &&
    (!journal ||
      (journal.phase === "APPLIED" && journal.receipt?.state === "APPLIED") ||
      (journal.phase === "CANCELLED" && journal.receipt?.state === "CANCELLED"))
  );
}

/** A current-generation observation is best effort and never alters runtime readiness/history. */
export async function reportCurrentRepositoryGit(
  profile: Pick<StateStore, "read">,
  settings: CurrentSettings,
  origin: string,
  credential: string,
  signal: AbortSignal,
  options: ObservationOptions = {},
): Promise<void> {
  const check = () => {
    if (signal.aborted) throw new RuntimeError("AUTHORITY_LOST");
  };
  try {
    check();
    const before = await settings.read(check);
    check();
    const pointer = before?.current;
    if (!idle(before) || !pointer || pointer.legacy || pointer.configRevision <= 0) return;
    const connected = async (context?: OwnedContext) => {
      check();
      const current = await profile.read();
      check();
      const mapping = current?.mappings.find((value) => value.agentId === pointer.agentId);
      return (
        mapping?.formatVersion === 2 &&
        mapping.workspaceId === pointer.workspaceId &&
        mapping.bindingEpoch === pointer.bindingEpoch &&
        mapping.generation === pointer.generation &&
        mapping.runtime === pointer.provider &&
        (!context ||
          (mapping.root === context.root.path && mapping.nativeSessionId === context.threadId)) &&
        current?.status === "connected" &&
        current.credential === credential &&
        current.server === origin &&
        before.server === origin &&
        current.deviceId === before.deviceId &&
        current.scope?.organizationId === before.organizationId &&
        current.scope.roomId === before.roomId
      );
    };
    if (!(await connected())) return;
    const runtime = settings.generationStore(pointer.agentId, pointer.generation);
    const record = await runtime.read();
    check();
    const context = record?.context;
    if (
      !record ||
      !context ||
      record.preparation ||
      !record.settings ||
      record.scope.server !== before.server ||
      record.scope.deviceId !== before.deviceId ||
      record.scope.organizationId !== before.organizationId ||
      record.scope.roomId !== before.roomId ||
      record.scope.agentId !== pointer.agentId ||
      record.scope.bindingEpoch !== pointer.bindingEpoch ||
      context.generation !== pointer.generation ||
      context.epoch !== pointer.bindingEpoch ||
      record.settings.provider !== pointer.provider ||
      (context.provider ?? "codex") !== pointer.provider
    )
      return;
    repositoryMode(record.settings, context);
    if (
      record.settings.repositoryAccess &&
      record.settings.repositoryAccess.localRootReference !== pointer.localRootReference
    )
      return;
    if (!(await connected(context))) return;
    const observation = await (options.observe ?? collectSourceObservation)(
      context.root,
      [],
      check,
      signal,
    );
    check();
    const after = await settings.read(check);
    check();
    if (!idle(after) || stableJson(before) !== stableJson(after) || !(await connected(context)))
      return;
    const latest = await runtime.read();
    check();
    if (
      !latest?.context ||
      latest.preparation ||
      stableJson(latest.scope) !== stableJson(record.scope) ||
      stableJson(latest.context) !== stableJson(context)
    )
      return;
    const root = await RuntimeFilePolicy.root(context.root.path, check);
    check();
    if (stableJson(root) !== stableJson(context.root)) return;
    // CentralClient retains its strict, bounded response handling; the fetch seam adds shutdown.
    const client = new CentralClient(origin, (url, init) => {
      check();
      return (options.fetcher ?? fetch)(url, {
        ...init,
        signal: AbortSignal.any([signal, init!.signal!]),
      });
    });
    check();
    await client.call(
      "git-report",
      {
        agentId: pointer.agentId,
        workspaceId: pointer.workspaceId,
        bindingEpoch: pointer.bindingEpoch,
        configRevision: pointer.configRevision,
        branch: observation.git.ref ?? "unknown",
        commit: observation.git.commit ?? "unknown",
        observedAt: observation.git.observedAt,
      },
      credential,
    );
  } catch {
    // Git, clock, storage and network failures must not expose private details or break presence.
  }
}

/** Runs inside the existing serial heartbeat loop, with no additional timer or retry. */
export async function heartbeatWithGitReport<T>(
  heartbeat: () => Promise<T>,
  report: () => Promise<void>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return;
  const result = await heartbeat();
  if (!signal.aborted) {
    try {
      await report();
    } catch {
      /* Presence success is independent of Git reporting. */
    }
  }
  return result;
}

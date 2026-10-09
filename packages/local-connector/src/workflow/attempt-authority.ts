import { isOriginRoleRequestKind } from "../workspace/tool-contracts.ts";
import { isHash } from "../contracts.ts";
import {
  RuntimeError,
  type AttemptAuthority,
  type AttemptJournal,
  type NativeInterruption,
  type NativeToolCancellation,
  type RuntimeRecord,
  type ToolCall,
  type ToolResult,
} from "../runtime-contracts.ts";
import type { AttemptSnapshot } from "../workflow-contracts.ts";

type PendingTool = { hash: string; closed: boolean; intent?: Promise<void> };
/** Callbacks share the runner's live journal, serialized writes and cleanup fence. */
interface AttemptHost {
  assertLive(): void;
  journal(record: RuntimeRecord): AttemptJournal;
  mutate(kind: string, update: (record: RuntimeRecord) => void, guard: () => void): Promise<void>;
  openTools(): void;
  tool(call: ToolCall): Promise<ToolResult>;
  pendingTool(callId: string): PendingTool | undefined;
  interruptionStorage(authority: AttemptAuthority, proof: NativeInterruption): "OPEN" | "CLOSED";
  readonly interruptionWrites: Set<Promise<void>>;
  waitInterruptionStorage(write: Promise<void>, signal: AbortSignal): Promise<void>;
}
export function createAttemptAuthority(
  record: RuntimeRecord,
  snapshot: AttemptSnapshot,
  signal: AbortSignal,
  interruptionStorageClosed: AbortController,
  host: AttemptHost,
): AttemptAuthority {
  const authority: AttemptAuthority = {
    scope: structuredClone(record.scope),
    context: structuredClone(record.context!),
    attempt: snapshot,
    peerTools: isOriginRoleRequestKind(snapshot.payload.requestKind),
    signal: signal,
    assertLive: () => host.assertLive(),
    ack: (threadId, turnId, initHash) =>
      acknowledgeNativeInput(authority, host, threadId, turnId, initHash),
    tool: async (call) => host.tool(call),
    cancelledTool: (proof) => cancelNativeTool(host, proof),
    interruption: (proof) =>
      saveNativeInterruption(authority, interruptionStorageClosed, host, proof),
  };
  return authority;
}

async function acknowledgeNativeInput(
  authority: AttemptAuthority,
  host: AttemptHost,
  threadId: string,
  turnId: string,
  initHash?: string,
): Promise<void> {
  host.assertLive();
  if (
    threadId !== authority.context.threadId ||
    authority.context.ownedTurns.some((t) => t.turnId === turnId)
  )
    throw new RuntimeError("UNKNOWN");
  await host.mutate(
    "native-ack",
    (record) => {
      const a = host.journal(record);
      if (a.state !== "PROVIDER_INTENT") throw new RuntimeError("UNKNOWN");
      if (record.settings?.provider === "claude") {
        if (
          !a.nativeIntent ||
          a.nativeIntent.sessionId !== threadId ||
          a.nativeIntent.inputId !== turnId ||
          !isHash(initHash) ||
          !record.context?.materialization
        )
          throw new RuntimeError("UNKNOWN");
        if (record.context.materialization.state === "RESERVED") {
          record.context.materialization.state = "MATERIALIZED";
          record.context.materialization.initHash = initHash;
        }
      }
      a.native = { threadId, turnId };
      a.state = "ACKNOWLEDGED";
    },
    () => host.assertLive(),
  );
  host.assertLive();
  host.openTools();
}

async function cancelNativeTool(host: AttemptHost, proof: NativeToolCancellation): Promise<void> {
  const pending = host.pendingTool(proof.callId);
  if (pending) {
    if (pending.hash !== proof.payloadHash) throw new RuntimeError("UNKNOWN");
    // Close this exact call before waiting for its intent write; never wait for reader I/O.
    pending.closed = true;
    await pending.intent;
  }
  await host.mutate(
    "native-tool-cancellation",
    (record) => {
      const a = host.journal(record);
      if (
        record.settings?.provider !== "claude" ||
        !a.nativeIntent ||
        !a.native ||
        !a.toolCalls.some(
          (call) => call.callId === proof.callId && call.payloadHash === proof.payloadHash,
        ) ||
        (a.toolCancellations ?? []).some(
          (c) => c.callId === proof.callId || c.controlId === proof.controlId,
        )
      )
        throw new RuntimeError("UNKNOWN");
      (a.toolCancellations ??= []).push(structuredClone(proof));
    },
    () => host.assertLive(),
  );
}

async function saveNativeInterruption(
  authority: AttemptAuthority,
  interruptionStorageClosed: AbortController,
  host: AttemptHost,
  proof: NativeInterruption,
): Promise<"SAVED" | "CLOSED"> {
  if (host.interruptionStorage(authority, proof) === "CLOSED") return "CLOSED";
  const guard = () => {
    if (interruptionStorageClosed.signal.aborted) throw new RuntimeError("RUNTIME_CLOSED");
    if (host.interruptionStorage(authority, proof) === "CLOSED")
      throw new RuntimeError("AUTHORITY_LOST");
  };
  const write = host.mutate(
    "native-interruption",
    (record) => {
      const a = host.journal(record);
      if (proof.receipt && !a.nativeInterruption) throw new RuntimeError("UNKNOWN");
      a.nativeInterruption = structuredClone(proof);
    },
    guard,
  );
  host.interruptionWrites.add(write);
  try {
    await host.waitInterruptionStorage(write, interruptionStorageClosed.signal);
    return "SAVED";
  } finally {
    host.interruptionWrites.delete(write);
  }
}

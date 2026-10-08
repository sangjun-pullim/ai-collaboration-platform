import { isHash } from "../contracts.ts";
import {
  digest,
  stableJson,
  claudeInterruptRequest,
  type OwnedContext,
  type TerminalEvidence,
} from "../runtime-contracts.ts";
import { isNativeRepositoryTool } from "../workspace/tool-contracts.ts";

export type InterruptionEvidence = Pick<
  TerminalEvidence,
  "terminal" | "nativeInterruption" | "toolCancellations"
>;
export type InterruptionInput = {
  turnId: string;
  promptHash: string;
  interruption?: InterruptionEvidence;
};
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const boundedId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 200;

/** These native messages never acknowledge input, grant a read, or prove a terminal. */
export function isInterruptionUserContent(
  message: Record<string, unknown>,
  cancelled: (id: string) => boolean,
  allowMarker: boolean,
): boolean {
  const content = message.content;
  if (
    message.role !== "user" ||
    !Array.isArray(content) ||
    !content.length ||
    content.length > 64 ||
    content.some((block) => !record(block))
  )
    return false;
  if (content.length === 1 && content[0].type === "text") {
    return (
      allowMarker &&
      exact(content[0], ["type", "text"]) &&
      ["[Request interrupted by user]", "[Request interrupted by user for tool use]"].includes(
        content[0].text,
      )
    );
  }
  const ids = new Set<string>();
  return content.every((block) => {
    if (
      !exact(block, ["type", "tool_use_id", "is_error", "content"]) ||
      block.type !== "tool_result" ||
      !boundedId(block.tool_use_id) ||
      ids.has(block.tool_use_id) ||
      block.is_error !== true ||
      typeof block.content !== "string" ||
      Buffer.byteLength(block.content) > 65536 ||
      !cancelled(block.tool_use_id)
    )
      return false;
    ids.add(block.tool_use_id);
    return true;
  });
}

function ownedInterruption(context: OwnedContext, input: InterruptionInput): boolean {
  const evidence = input.interruption,
    proof = evidence?.nativeInterruption,
    intent = proof?.intent;
  if (
    evidence?.terminal !== "INTERRUPTED" ||
    !proof ||
    !intent ||
    intent.provider !== "claude" ||
    intent.sessionId !== context.threadId ||
    intent.inputId !== input.turnId ||
    intent.promptHash !== input.promptHash ||
    intent.generation !== context.generation ||
    intent.policyFingerprint !== context.materialization?.policyFingerprint ||
    intent.scope.bindingEpoch !== context.epoch ||
    proof.intentHash !== digest(stableJson(intent)) ||
    proof.requestHash !== digest(stableJson(claudeInterruptRequest))
  )
    return false;
  const receipt = proof.receipt;
  return (
    receipt === undefined ||
    (Array.isArray(receipt.stillQueued) &&
      receipt.stillQueued.length === 0 &&
      Array.isArray(receipt.cancelled) &&
      receipt.cancelled.length <= 1 &&
      receipt.cancelled.every((id) => id === input.turnId) &&
      receipt.responseHash ===
        digest(stableJson({ still_queued: [], cancelled: receipt.cancelled })))
  );
}

/** Admit bookkeeping only after a typed interrupted result and owned durable cancellation. */
export function isNativeInterruptionRecord(
  context: OwnedContext,
  input: InterruptionInput | undefined,
  message: Record<string, unknown>,
  tools: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  if (!input || !ownedInterruption(context, input)) return false;
  const cancellations = input.interruption!.toolCancellations ?? [];
  if (cancellations.length > 64) return false;
  const ids = new Set<string>(),
    controls = new Set<string>();
  for (const cancellation of cancellations) {
    const tool = tools.get(cancellation.callId);
    if (
      !exact(cancellation as unknown as Record<string, unknown>, [
        "callId",
        "controlId",
        "payloadHash",
        "cancelHash",
      ]) ||
      !boundedId(cancellation.callId) ||
      !boundedId(cancellation.controlId) ||
      ids.has(cancellation.callId) ||
      controls.has(cancellation.controlId) ||
      !tool ||
      !isNativeRepositoryTool(String(tool.name)) ||
      !isHash(cancellation.payloadHash) ||
      cancellation.payloadHash !==
        digest(
          stableJson({
            threadId: context.threadId,
            turnId: input.turnId,
            callId: cancellation.callId,
            namespace: "ai_collaboration_scoped",
            tool: String(tool.name).replace("mcp__ai_collaboration_scoped__", ""),
            arguments: tool.input,
          }),
        ) ||
      cancellation.cancelHash !==
        digest(stableJson({ type: "control_cancel_request", request_id: cancellation.controlId }))
    )
      return false;
    ids.add(cancellation.callId);
    controls.add(cancellation.controlId);
  }
  return isInterruptionUserContent(
    message,
    (id) => ids.has(id),
    ids.size > 0 || Boolean(input.interruption!.nativeInterruption!.receipt),
  );
}

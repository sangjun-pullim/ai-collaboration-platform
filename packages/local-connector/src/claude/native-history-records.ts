import { isId } from "../contracts.ts";
import { RuntimeError, digest } from "../runtime-contracts.ts";

function requireValue(value: unknown): asserts value {
  if (!value) throw new RuntimeError("CONTEXT_UNCONFIRMED");
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, limit = 256 * 1024): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= limit;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const counter = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Advisory records never supply a prompt, parent node, tool receipt, or terminal. */
export function nativeHistoryMetadata(
  frame: Record<string, unknown>,
  sessionId: string,
  parent: string | null,
  nextPromptHash: string | undefined,
): "ENQUEUE" | "DEQUEUE" | "ADVISORY" | null {
  if (
    !["queue-operation", "atis-latch", "last-prompt", "cost-state", "mode"].includes(
      String(frame.type),
    )
  )
    return null;
  requireValue(frame.sessionId === sessionId);
  if (frame.type === "queue-operation") {
    requireValue(keys(frame, ["type", "operation", "timestamp", "sessionId", "content"]));
    requireValue(text(frame.timestamp, 64) && Number.isFinite(Date.parse(frame.timestamp)));
    if (frame.operation === "enqueue") {
      requireValue(text(frame.content) && digest(frame.content) === nextPromptHash);
      return "ENQUEUE";
    }
    requireValue(frame.operation === "dequeue" && !Object.hasOwn(frame, "content"));
    return "DEQUEUE";
  }
  if (frame.type === "mode") {
    requireValue(keys(frame, ["type", "sessionId", "mode"]) && frame.mode === "normal");
  } else if (frame.type === "atis-latch") {
    requireValue(keys(frame, ["type", "sessionId", "atis"]) && text(frame.atis, 8192));
  } else if (frame.type === "last-prompt") {
    requireValue(keys(frame, ["type", "sessionId", "leafUuid", "lastPrompt"]));
    requireValue(parent !== null && frame.leafUuid === parent && text(frame.lastPrompt, 8192));
  } else validateCostState(frame);
  return "ADVISORY";
}

function validateCostState(frame: Record<string, unknown>): void {
  const counters = [
    "totalCostUSD",
    "totalAPIDuration",
    "totalAPIDurationWithoutRetries",
    "totalToolDuration",
    "totalLinesAdded",
    "totalLinesRemoved",
    "totalDuration",
    "startTime",
  ];
  requireValue(
    keys(frame, ["type", "sessionId", ...counters, "modelUsage", "hasUnknownModelCost"]),
  );
  requireValue(
    counters.every((key) => counter(frame[key])) && typeof frame.hasUnknownModelCost === "boolean",
  );
  requireValue(record(frame.modelUsage));
  const usage = frame.modelUsage;
  requireValue(
    Object.keys(usage).length <= 256 &&
      Object.entries(usage).every(
        ([name, value]) => text(name, 128) && record(value) && Object.values(value).every(counter),
      ),
  );
}

/** Attachments retain their checked chain identity and remain covered by the full prefix hash. */
export function validateNativeHistoryAttachment(frame: Record<string, unknown>): void {
  requireValue(!Object.hasOwn(frame, "message") && record(frame.attachment));
  const attachment = frame.attachment as Record<string, unknown>;
  const kind = attachment.type;
  if (kind === "environment") requireValue(record(attachment.snapshot));
  else if (kind === "model") requireValue(record(attachment.identity) && text(attachment.text));
  else if (kind === "total_tokens_reminder") requireValue(text(attachment.text));
  else if (kind === "instructions")
    requireValue(
      Array.isArray(attachment.files) &&
        attachment.files.length <= 256 &&
        attachment.files.every(record),
    );
  else if (kind === "session_context") requireValue(record(attachment.context));
  else if (kind === "date")
    requireValue(
      typeof attachment.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(attachment.date),
    );
  else if (kind === "credential_org") requireValue(isId(attachment.organizationUuid));
  else if (kind === "prompt_snapshot") validatePromptSnapshot(attachment);
  else requireValue(false);
  if (Object.hasOwn(frame, "rendered")) {
    requireValue(
      Array.isArray(frame.rendered) &&
        frame.rendered.length <= 64 &&
        frame.rendered.every((item) => record(item) && text(item.content)),
    );
    requireValue(frame.renderedRole === "system" || frame.renderedRole === "user");
  } else requireValue(!Object.hasOwn(frame, "renderedRole"));
}

function validatePromptSnapshot(attachment: Record<string, unknown>): void {
  requireValue(Array.isArray(attachment.systemPrompt) && attachment.systemPrompt.length <= 256);
  requireValue(attachment.systemPrompt.every((item) => text(item) || record(item)));
  requireValue(
    typeof attachment.reminderFold === "boolean" &&
      typeof attachment.echoWireToolInputs === "boolean" &&
      text(attachment.contextRendering, 8192),
  );
  for (const key of ["systemTurns", "toolChangeHeader", "inlineTools", "keptReminders"])
    if (Object.hasOwn(attachment, key)) requireValue(typeof attachment[key] === "boolean");
  if (Object.hasOwn(attachment, "tools"))
    requireValue(Array.isArray(attachment.tools) && attachment.tools.length <= 256);
  if (Object.hasOwn(attachment, "cliPrefix")) requireValue(text(attachment.cliPrefix));
}

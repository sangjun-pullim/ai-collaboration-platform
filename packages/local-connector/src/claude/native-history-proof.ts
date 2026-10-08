import { isHash, isId } from "../contracts.ts";
import { createHash } from "node:crypto";
import {
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  type NativeHistoryEvidence,
  type NativeInputIntent,
  type NativeObservation,
  type OwnedContext,
} from "../runtime-contracts.ts";
import { object, type OwnedHistory } from "./owned-history.ts";
import {
  isNativeInterruptionRecord,
  type InterruptionEvidence,
  type InterruptionInput,
} from "./native-interruption-records.ts";
import {
  nativeHistoryMetadata,
  validateNativeHistoryAttachment,
} from "./native-history-records.ts";

type Conversation = { inputId: string; index: number; value: string }[];
type Receipt = NonNullable<OwnedContext["ownedTurns"][number]["toolReceipts"]>[number];
type Input = InterruptionInput & { receipts: readonly Receipt[] };
const rejected = () => new RuntimeError("CONTEXT_UNCONFIRMED");

function promptText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1) {
    const block = object(content[0]);
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

/** Compare only stable, generation-relevant message fields, never volatile usage counters. */
function conversationValue(frame: Record<string, unknown>): string {
  const message = object(frame.message);
  if (message.role !== frame.type) throw rejected();
  const prompt = frame.type === "user" ? promptText(message) : null;
  return stableJson({
    type: frame.type,
    uuid: frame.uuid,
    message: {
      role: message.role,
      content: prompt === null ? message.content : prompt,
      ...(frame.type === "assistant" ? { model: message.model } : {}),
    },
  });
}

function parseConversation(
  context: OwnedContext,
  history: OwnedHistory,
  version: string,
  inputs: readonly Input[],
): Conversation {
  if (
    history.format !== "claude-jsonl-v1" ||
    !history.materialized ||
    history.sessionId !== context.threadId ||
    history.root !== context.root.path ||
    history.records.length === 0 ||
    history.records.length > 4096
  )
    throw rejected();
  const expected = new Map(inputs.map((input) => [input.turnId, input.promptHash]));
  const byInput = new Map(inputs.map((input) => [input.turnId, input]));
  if (expected.size !== inputs.length) throw rejected();
  const seen = new Set<string>();
  const started: string[] = [];
  const conversation: Conversation = [];
  let parent: string | null = null;
  let current: string | undefined;
  let toolBlocks = new Map<string, Record<string, unknown>>();
  let queued = false;
  for (const [index, frame] of history.records.entries()) {
    if (frame.type === "file-history-snapshot") {
      if (!isId(frame.messageId) || !expected.has(frame.messageId)) throw rejected();
      object(frame.snapshot);
      if (typeof frame.isSnapshotUpdate !== "boolean") throw rejected();
      continue;
    }
    if (version === "2.1.293") {
      const metadata = nativeHistoryMetadata(
        frame,
        context.threadId,
        parent,
        inputs[started.length]?.promptHash,
      );
      if (metadata) {
        if (metadata === "ENQUEUE") {
          if (queued) throw rejected();
          queued = true;
        } else if (metadata === "DEQUEUE") {
          if (!queued) throw rejected();
          queued = false;
        }
        continue;
      }
    }
    const attachment = version === "2.1.293" && frame.type === "attachment";
    if (frame.type !== "user" && frame.type !== "assistant" && !attachment) throw rejected();
    if (
      frame.sessionId !== context.threadId ||
      frame.cwd !== context.root.path ||
      frame.version !== version ||
      frame.isSidechain !== false ||
      !isId(frame.uuid) ||
      seen.has(frame.uuid) ||
      frame.parentUuid !== parent
    )
      throw rejected();
    seen.add(frame.uuid);
    parent = frame.uuid;
    if (attachment) {
      if (!current) throw rejected();
      validateNativeHistoryAttachment(frame);
      continue;
    }
    const message = object(frame.message);
    if (frame.type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content.map(object))
        if (block.type === "tool_use" && typeof block.id === "string")
          toolBlocks.set(block.id, block);
    }
    if (
      version === "2.1.293" &&
      frame.type === "user" &&
      isNativeInterruptionRecord(
        context,
        current ? byInput.get(current) : undefined,
        message,
        toolBlocks,
      )
    )
      continue;
    const prompt = frame.type === "user" ? promptText(message) : null;
    if (prompt !== null) {
      if (digest(prompt) !== expected.get(frame.uuid) || started.includes(frame.uuid))
        throw rejected();
      if (inputs[started.length]?.turnId !== frame.uuid) throw rejected();
      started.push(frame.uuid);
      current = frame.uuid;
      toolBlocks = new Map();
    } else {
      if (!current || !Array.isArray(message.content) || message.content.length > 64)
        throw rejected();
      if (
        frame.type === "user" &&
        (!message.content.length ||
          message.content.some((raw) => object(raw).type !== "tool_result"))
      )
        throw rejected();
    }
    if (!current) throw rejected();
    conversation.push({ inputId: current, index, value: conversationValue(frame) });
  }
  if (queued || started.length !== inputs.length) throw rejected();
  proveToolResults(context, history, conversation, inputs);
  return conversation;
}

function proveToolResults(
  context: OwnedContext,
  history: OwnedHistory,
  conversation: Conversation,
  inputs: readonly Input[],
) {
  const receipts = new Map(
    inputs.map((input) => [
      input.turnId,
      new Map(input.receipts.map((receipt) => [receipt.callId, receipt])),
    ]),
  );
  const tools = new Map<string, Record<string, unknown>>();
  for (const message of conversation) {
    const frame = history.records[message.index];
    const content = object(frame.message).content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = object(raw);
      const callId = frame.type === "assistant" ? block.id : block.tool_use_id;
      const receipt = receipts.get(message.inputId)?.get(String(callId));
      const key = `${message.inputId}:${String(callId)}`;
      if (frame.type === "assistant" && block.type === "tool_use") {
        tools.set(key, block);
        if (
          receipt &&
          (typeof block.name !== "string" ||
            receipt.payloadHash !==
              digest(
                stableJson({
                  threadId: context.threadId,
                  turnId: message.inputId,
                  callId,
                  namespace: scopedNamespace,
                  tool: block.name.replace(`mcp__${scopedNamespace}__`, ""),
                  arguments: block.input,
                }),
              ))
        )
          throw rejected();
      } else if (frame.type === "user" && block.type === "tool_result") {
        if (
          !tools.has(key) ||
          !receipt ||
          receipt.responseHash !==
            digest(
              stableJson({
                content: block.content,
                isError: block.is_error === true,
              }),
            )
        )
          throw rejected();
      }
    }
  }
}

function prefixHashes(history: OwnedHistory, counts: readonly number[]) {
  const wanted = new Set([...counts, history.records.length]);
  const hashes = new Map<number, string>();
  const hash = createHash("sha256").update("[");
  for (const [index, record] of history.records.entries()) {
    if (index) hash.update(",");
    hash.update(stableJson(record));
    if (wanted.has(index + 1)) hashes.set(index + 1, hash.copy().update("]").digest("hex"));
  }
  return hashes;
}

function proveClosedPrefixes(
  context: OwnedContext,
  history: OwnedHistory,
  conversation: Conversation,
) {
  const hashes = prefixHashes(
    history,
    context.ownedTurns.flatMap((turn) =>
      turn.nativeHistory?.state === "VERIFIED" ? [turn.nativeHistory.recordCount] : [],
    ),
  );
  let count = 0;
  for (const turn of context.ownedTurns) {
    const checkpoint = turn.nativeHistory;
    if (
      !isHash(turn.promptHash) ||
      !isHash(turn.resultHash) ||
      !turn.toolReceipts ||
      !checkpoint ||
      checkpoint.state !== "VERIFIED" ||
      checkpoint.format !== "claude-jsonl-v1" ||
      !Number.isSafeInteger(checkpoint.recordCount) ||
      checkpoint.recordCount <= count ||
      checkpoint.recordCount > history.records.length ||
      checkpoint.prefixHash !== hashes.get(checkpoint.recordCount)
    )
      throw rejected();
    const owned = conversation.filter((message) => message.inputId === turn.turnId);
    if (
      !owned.length ||
      owned[0].index < count ||
      owned.some((message) => message.index >= checkpoint.recordCount) ||
      conversation.some(
        (message) =>
          message.index >= count &&
          message.index < checkpoint.recordCount &&
          message.inputId !== turn.turnId,
      )
    )
      throw rejected();
    count = checkpoint.recordCount;
  }
  return { count, fullHash: hashes.get(history.records.length)! };
}

/** Native files prove a completed live input's unchanged conversation, never a new terminal. */
export function proveNativeHistory(
  context: OwnedContext,
  history: OwnedHistory,
  version: string,
  candidate?: NativeObservation,
): null {
  if (!history.materialized) {
    if (
      history.format !== "claude-jsonl-v1" ||
      history.sessionId !== context.threadId ||
      history.root !== context.root.path ||
      history.records.length ||
      context.ownedTurns.length ||
      context.materialization?.state === "MATERIALIZED"
    )
      throw rejected();
    return null;
  }
  const inputs: Input[] = context.ownedTurns.map((turn) => {
    if (!turn.promptHash) throw rejected();
    return {
      turnId: turn.turnId,
      promptHash: turn.promptHash,
      receipts: turn.toolReceipts ?? [],
      interruption: {
        terminal: turn.terminal,
        nativeInterruption: turn.nativeInterruption,
        toolCancellations: turn.toolCancellations,
      },
    };
  });
  if (candidate) {
    const intent = candidate.intent;
    if (
      !intent ||
      intent.sessionId !== context.threadId ||
      candidate.threadId !== context.threadId ||
      candidate.turnId !== intent.inputId ||
      intent.generation !== context.generation ||
      intent.policyFingerprint !== context.materialization?.policyFingerprint
    )
      throw rejected();
    const owned = inputs.find((input) => input.turnId === candidate.turnId);
    if (owned && owned.promptHash !== intent.promptHash) throw rejected();
    if (!owned)
      inputs.push({
        turnId: candidate.turnId,
        promptHash: intent.promptHash,
        receipts: (candidate.toolCalls ?? [])
          .filter((call) => call.result !== null)
          .map((call) => ({
            callId: call.callId,
            payloadHash: call.payloadHash,
            responseHash: digest(
              stableJson({
                content: call.result!.contentItems.map((item) => ({
                  type: "text",
                  text: item.text,
                })),
                isError: !call.result!.success,
              }),
            ),
          })),
      });
  }
  const conversation = parseConversation(context, history, version, inputs);
  const { count: closedCount } = proveClosedPrefixes(context, history, conversation);
  if (!candidate && closedCount !== history.records.length) throw rejected();
  // Assistant text without the persisted live result cannot close an UNKNOWN input.
  return null;
}

/** Called only after the adapter's typed terminal and owned-child cleanup barriers. */
export function checkpointNativeHistory(
  context: OwnedContext,
  history: OwnedHistory,
  version: string,
  intent: NativeInputIntent,
  liveFrames: readonly Record<string, unknown>[],
  receipts: readonly Receipt[] = [],
  interruption?: InterruptionEvidence,
): NativeHistoryEvidence {
  if (!history.materialized) return { state: "UNVERIFIED", reason: "MISSING_HISTORY" };
  try {
    if (
      intent.provider !== "claude" ||
      intent.scope.bindingEpoch !== context.epoch ||
      intent.sessionId !== context.threadId ||
      intent.generation !== context.generation ||
      intent.policyFingerprint !== context.materialization?.policyFingerprint ||
      context.ownedTurns.some((turn) => turn.turnId === intent.inputId)
    )
      throw rejected();
    const inputs: Input[] = context.ownedTurns.map((turn) => {
      if (!turn.promptHash) throw rejected();
      return {
        turnId: turn.turnId,
        promptHash: turn.promptHash,
        receipts: turn.toolReceipts ?? [],
        interruption: {
          terminal: turn.terminal,
          nativeInterruption: turn.nativeInterruption,
          toolCancellations: turn.toolCancellations,
        },
      };
    });
    inputs.push({
      turnId: intent.inputId,
      promptHash: intent.promptHash,
      receipts: [...receipts],
      interruption,
    });
    const conversation = parseConversation(context, history, version, inputs);
    const { count: closedCount, fullHash } = proveClosedPrefixes(context, history, conversation);
    const current = conversation.filter((message) => message.inputId === intent.inputId);
    if (
      !current.length ||
      current.some((message) => message.index < closedCount) ||
      stableJson(current.map((message) => message.value)) !==
        stableJson(liveConversation(context, inputs.at(-1)!, version, liveFrames))
    )
      throw rejected();
    return {
      state: "VERIFIED",
      format: "claude-jsonl-v1",
      recordCount: history.records.length,
      prefixHash: fullHash,
    };
  } catch {
    return { state: "UNVERIFIED", reason: "HISTORY_REJECTED" };
  }
}

function liveConversation(
  context: OwnedContext,
  input: Input,
  version: string,
  frames: readonly Record<string, unknown>[],
): string[] {
  const tools = new Map<string, Record<string, unknown>>(),
    values: string[] = [];
  for (const frame of frames) {
    const message = object(frame.message);
    if (frame.type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content.map(object))
        if (block.type === "tool_use" && typeof block.id === "string") tools.set(block.id, block);
    }
    if (
      version !== "2.1.293" ||
      frame.type !== "user" ||
      !isNativeInterruptionRecord(context, input, message, tools)
    )
      values.push(conversationValue(frame));
  }
  return values;
}

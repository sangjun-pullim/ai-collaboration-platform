import {
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  claudeInterruptRequest,
  type NativeObservation,
  type OwnedContext,
  type NativeToolCancellation,
  type NativeInterruption,
  type RepositoryToolPolicy,
  type RuntimeSettings,
} from "../runtime-contracts.ts";
import {
  NativeInputProof,
  nativeIdentity,
  NATIVE_TOOL_NAMES,
  type InputTerminal,
} from "./input-proof.ts";
import {
  nativeToolNames,
  isNativeRepositoryTool,
  scopedToolName,
  validateToolArguments,
} from "../workspace/tool-contracts.ts";
import { validToolPolicy, repositoryMode } from "../workspace/repository-access.ts";
import { object, type OwnedHistory } from "./owned-history.ts";
import { proveNativeHistory } from "./native-history-proof.ts";

type Receipt = { callId: string; payloadHash: string; responseHash: string };
type Input = {
  id: string;
  promptHash: string;
  receipts: Receipt[];
  cancellations: NativeToolCancellation[];
  interruption?: NativeInterruption;
  toolPolicy?: RepositoryToolPolicy;
  closed?: OwnedContext["ownedTurns"][number];
};
export interface ObservedTerminal {
  terminal: InputTerminal;
  initHash: string;
  model: string | null;
  id: string;
}

function interruptionMatches(
  input: Input,
  context: OwnedContext,
  candidate?: NativeObservation,
): boolean {
  const proof = input.interruption;
  if (!proof) return false;
  const intent = proof.intent;
  if (
    !intent ||
    !intent.scope ||
    intent.provider !== "claude" ||
    intent.sessionId !== context.threadId ||
    intent.inputId !== input.id ||
    intent.promptHash !== input.promptHash ||
    intent.generation !== context.generation ||
    intent.scope.bindingEpoch !== context.epoch ||
    intent.policyFingerprint !== context.materialization?.policyFingerprint ||
    proof.intentHash !== digest(stableJson(intent)) ||
    proof.requestHash !== digest(stableJson(claudeInterruptRequest)) ||
    (input.id === candidate?.turnId && stableJson(intent) !== stableJson(candidate.intent))
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  if (
    proof.receipt &&
    (!Array.isArray(proof.receipt.stillQueued) ||
      proof.receipt.stillQueued.length !== 0 ||
      !Array.isArray(proof.receipt.cancelled) ||
      proof.receipt.cancelled.length > 1 ||
      proof.receipt.cancelled.some((id) => id !== input.id) ||
      proof.receipt.responseHash !==
        digest(stableJson({ still_queued: [], cancelled: proof.receipt.cancelled })))
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  return true;
}

function inputText(frame: Record<string, unknown>): string | null {
  if (frame.type !== "user" || frame.parent_tool_use_id != null) return null;
  const message = object(frame.message);
  if (message.role !== "user") throw new RuntimeError("UNKNOWN");
  const content = message.content;
  if (typeof content === "string") return content;
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    object(content[0]).type === "text" &&
    typeof object(content[0]).text === "string"
  )
    return object(content[0]).text as string;
  return null;
}

function toolResult(
  proof: NativeInputProof,
  frame: Record<string, unknown>,
  input: Input,
  initHash: string | null,
  sessionId: string,
  tools: Map<string, Record<string, unknown>>,
) {
  const content = object(frame.message).content;
  if (!Array.isArray(content) || content.length === 0) throw new RuntimeError("UNKNOWN");
  for (const raw of content) {
    const block = object(raw),
      tool = tools.get(String(block.tool_use_id));
    const receipt = input.receipts.find((receipt) => receipt.callId === block.tool_use_id);
    if (block.type !== "tool_result" || !tool || !receipt || typeof tool.name !== "string")
      throw new RuntimeError("UNKNOWN");
    const name = tool.name.replace(`mcp__${scopedNamespace}__`, "");
    const hash = digest(
      stableJson({
        threadId: sessionId,
        turnId: input.id,
        callId: block.tool_use_id,
        namespace: scopedNamespace,
        tool: name,
        arguments: tool.input,
      }),
    );
    if (
      hash !== receipt.payloadHash ||
      digest(stableJson({ content: block.content, isError: block.is_error === true })) !==
        receipt.responseHash
    )
      throw new RuntimeError("UNKNOWN");
    const controlId = `observe-${String(block.tool_use_id)}`;
    proof.claim(
      controlId,
      {
        name,
        arguments: tool.input,
        _meta: {
          session_id: sessionId,
          user_message_uuid: input.id,
          tool_use_id: block.tool_use_id,
        },
      },
      initHash !== null,
    );
    proof.responseWritten(controlId);
  }
  proof.user(frame);
}

/** Replay the entire exact history, including closed inputs; no native command is sent. */
export function proveOwnedHistory(
  context: OwnedContext,
  history: OwnedHistory,
  version: string,
  candidate?: NativeObservation,
  settings?: RuntimeSettings,
): ObservedTerminal | null {
  if (history.format === "claude-jsonl-v1")
    return proveNativeHistory(context, history, version, candidate);
  if (
    history.sessionId !== context.threadId ||
    history.root !== context.root.path ||
    history.records.length > 4096
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  if (!history.materialized) {
    if (context.materialization?.state === "MATERIALIZED")
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    return null;
  }
  const inputs = new Map<string, Input>();
  for (const turn of context.ownedTurns) {
    if (!turn.promptHash || !turn.resultHash || !turn.toolReceipts)
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    inputs.set(turn.turnId, {
      id: turn.turnId,
      promptHash: turn.promptHash,
      receipts: turn.toolReceipts,
      cancellations: turn.toolCancellations ?? [],
      interruption: turn.nativeInterruption,
      toolPolicy: turn.toolPolicy,
      closed: turn,
    });
  }
  if (candidate?.intent && inputs.has(candidate.turnId)) {
    const existing = inputs.get(candidate.turnId)!;
    if (
      existing.promptHash !== candidate.intent.promptHash ||
      stableJson(existing.toolPolicy ?? null) !== stableJson(candidate.intent.toolPolicy ?? null) ||
      stableJson(existing.interruption ?? null) !==
        stableJson(candidate.nativeInterruption ?? null) ||
      stableJson(existing.cancellations) !== stableJson(candidate.toolCancellations ?? [])
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  if (candidate?.intent && !inputs.has(candidate.turnId)) {
    inputs.set(candidate.turnId, {
      id: candidate.turnId,
      promptHash: candidate.intent.promptHash,
      toolPolicy: candidate.intent.toolPolicy,
      cancellations: candidate.toolCancellations ?? [],
      interruption: candidate.nativeInterruption,
      receipts: (candidate.toolCalls ?? [])
        .filter((call) => call.result !== null)
        .map((call) => ({
          callId: call.callId,
          payloadHash: call.payloadHash,
          responseHash: digest(
            stableJson({
              content: call.result!.contentItems.map((item) => ({ type: "text", text: item.text })),
              isError: !call.result!.success,
            }),
          ),
        })),
    });
  }
  for (const input of inputs.values()) {
    if (
      input.toolPolicy &&
      (!validToolPolicy(input.toolPolicy) ||
        (input.toolPolicy.mode === "AUTO_CODE" &&
          (!settings || repositoryMode(settings, context) !== "AUTO_CODE")) ||
        (settings && input.toolPolicy.mode !== repositoryMode(settings, context)) ||
        (input.toolPolicy.peerAllowed && settings && !settings.autoQuestionsConfirmed))
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  const completed = new Set<string>(),
    seen = new Set<string>();
  let current: Input | undefined,
    proof: NativeInputProof | undefined,
    initHash: string | null = null,
    initialHash: string | null = null,
    model: string | null = null;
  let pendingInit: Record<string, unknown> | undefined;
  let initializedTools: readonly string[] = [];
  let observed: ObservedTerminal | null = null;
  let tools = new Map<string, Record<string, unknown>>();
  for (const frame of history.records) {
    if (
      frame.session_id !== context.threadId ||
      (frame.cwd !== undefined && frame.cwd !== context.root.path)
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    if (frame.type === "system" && frame.subtype === "init") {
      if (pendingInit) throw new RuntimeError("CONTEXT_UNCONFIRMED");
      if (current && !completed.has(current.id)) {
        const legacyAllowed =
          Array.isArray(frame.tools) && frame.tools.includes(`mcp__${scopedNamespace}__ask_peer`)
            ? NATIVE_TOOL_NAMES
            : [`mcp__${scopedNamespace}__read_workspace_file`];
        nativeIdentity(
          frame,
          context.threadId,
          context.root.path,
          version,
          current.toolPolicy
            ? nativeToolNames(current.toolPolicy.mode, current.toolPolicy.peerAllowed)
            : legacyAllowed,
        );
      } else pendingInit = frame;
      initHash = digest(stableJson(frame));
      initialHash ??= initHash;
      initializedTools = Array.isArray(frame.tools)
        ? frame.tools.filter(
            (name): name is string => typeof name === "string" && name !== "EndConversation",
          )
        : [];
      continue;
    }
    const prompt = inputText(frame);
    if (prompt !== null) {
      if (
        (current && !completed.has(current.id)) ||
        typeof frame.uuid !== "string" ||
        seen.has(frame.uuid)
      )
        throw new RuntimeError("UNKNOWN");
      current = inputs.get(frame.uuid);
      if (!current || digest(prompt) !== current.promptHash)
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      const policy = current.toolPolicy;
      const allowed = policy ? nativeToolNames(policy.mode, policy.peerAllowed) : NATIVE_TOOL_NAMES;
      if (pendingInit) {
        const legacyAllowed =
          Array.isArray(pendingInit.tools) &&
          pendingInit.tools.includes(`mcp__${scopedNamespace}__ask_peer`)
            ? NATIVE_TOOL_NAMES
            : [`mcp__${scopedNamespace}__read_workspace_file`];
        nativeIdentity(
          pendingInit,
          context.threadId,
          context.root.path,
          version,
          policy ? allowed : legacyAllowed,
        );
        pendingInit = undefined;
      }
      seen.add(current.id);
      tools = new Map();
      model = null;
      proof = new NativeInputProof(
        context.threadId,
        current.id,
        current.promptHash,
        allowed,
        policy,
      );
      proof.user(frame);
      continue;
    }
    if (!current || !proof) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    if (frame.type === "assistant") {
      const blocks = object(frame.message).content;
      if (Array.isArray(blocks)) {
        for (const block of blocks.map(object).filter((block) => block.type === "tool_use")) {
          if (typeof block.name !== "string" || !initializedTools.includes(block.name))
            throw new RuntimeError("TOOL_REJECTED");
          validateToolArguments(
            current.toolPolicy?.mode ?? "SELECTED",
            settings?.files ?? null,
            current.toolPolicy?.peerAllowed ??
              initializedTools.includes(`mcp__${scopedNamespace}__ask_peer`),
            scopedToolName(block.name),
            block.input,
          );
        }
      }
      model = proof.assistant(frame, initHash !== null);
      const content = object(frame.message).content as unknown[];
      for (const block of content.map(object).filter((block) => block.type === "tool_use"))
        tools.set(String(block.id), block);
    } else if (frame.type === "user")
      toolResult(proof, frame, current, initHash, context.threadId, tools);
    else if (frame.type === "result") {
      const interrupted =
        interruptionMatches(current, context, candidate) ||
        current.closed?.terminal === "INTERRUPTED" ||
        (current.id === candidate?.turnId && current.cancellations.length > 0);
      if (interrupted) {
        // Native JSONL lacks control replies; only durable, input-scoped product proof restores them.
        for (const cancellation of current.cancellations) {
          const tool = tools.get(cancellation.callId);
          if (
            !tool ||
            typeof tool.name !== "string" ||
            !isNativeRepositoryTool(tool.name) ||
            cancellation.cancelHash !==
              digest(
                stableJson({ type: "control_cancel_request", request_id: cancellation.controlId }),
              ) ||
            cancellation.payloadHash !==
              digest(
                stableJson({
                  threadId: context.threadId,
                  turnId: current.id,
                  callId: cancellation.callId,
                  namespace: scopedNamespace,
                  tool: scopedToolName(String(tool.name)),
                  arguments: tool.input,
                }),
              )
          )
            throw new RuntimeError("CONTEXT_UNCONFIRMED");
          proof.claim(
            cancellation.controlId,
            {
              name: scopedToolName(String(tool.name)),
              arguments: tool.input,
              _meta: {
                session_id: context.threadId,
                user_message_uuid: current.id,
                tool_use_id: cancellation.callId,
              },
            },
            initHash !== null,
          );
        }
        proof.requestInterrupt();
        if (current.interruption?.receipt) {
          const receipt = current.interruption.receipt;
          proof.receipt({ still_queued: receipt.stillQueued, cancelled: receipt.cancelled });
        }
        for (const cancellation of current.cancellations)
          proof.cancel({ type: "control_cancel_request", request_id: cancellation.controlId });
      }
      const terminal = proof.result(frame, initHash !== null);
      if (
        current.closed &&
        (terminal.kind !== current.closed.terminal ||
          terminal.evidenceHash !== current.closed.resultHash)
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      completed.add(current.id);
      if (current.id === candidate?.turnId)
        observed = { terminal, initHash: initHash!, model, id: String(frame.uuid) };
    } else if (frame.type === "system" && frame.subtype === "thinking_tokens")
      proof.progress(frame, initHash !== null);
    else if (frame.type === "command_lifecycle") proof.command(frame);
    else throw new RuntimeError("UNKNOWN");
  }
  if (pendingInit) {
    nativeIdentity(pendingInit, context.threadId, context.root.path, version, [
      `mcp__${scopedNamespace}__read_workspace_file`,
    ]);
  }
  if (context.ownedTurns.some((turn) => !completed.has(turn.turnId)))
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  if (
    context.materialization?.state === "MATERIALIZED" &&
    initialHash !== context.materialization.initHash
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  return observed;
}

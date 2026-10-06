import { AsyncLocalStorage } from "node:async_hooks";
import { RepositoryReader } from "../workspace/repository-reader.ts";
import { repositoryMode } from "../workspace/repository-access.ts";
import { isRepositoryTool, validateToolArguments } from "../workspace/tool-contracts.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type OwnedContext,
  type RuntimeSettings,
  type RepositoryToolIntent,
  type RepositoryToolObservation,
  type PeerEvidenceObservation,
  type RepositoryExcerpt,
  type ToolResult,
} from "../runtime-contracts.ts";

// JSON core output is already escaped: embedding it costs at most twice its UTF-8 bytes.
// Each of sixteen excerpts reserves 6*512 path bytes plus 512 metadata bytes; callId
// reserves 6*512 bytes. The remaining 4096 bytes cover intent, wrapper and row metadata.
export const repositoryToolReserveBytes = 2 * 8192 + 16 * (6 * 512 + 512) + 6 * 512 + 4096;
// Four evidence entries, a maximally escaped question, callId and operation/receipt metadata.
export const peerEvidenceReserveBytes = 4 * (6 * 512 + 1024) + 6 * 2000 + 6 * 512 + 8192;
const excerpt = (file: RepositoryExcerpt): RepositoryExcerpt => ({
  path: file.path,
  hash: file.hash,
  readAt: file.readAt,
  byteStart: file.byteStart,
  byteEnd: file.byteEnd,
  excerptHash: file.excerptHash,
});

/** One handler and reader belong to one live attempt; asynchronous guards stay call-local. */
export class RepositoryTools {
  private readonly reader: RepositoryReader;
  private readonly guards = new AsyncLocalStorage<() => void>();
  private readonly generation: string;
  private readonly approvalHash: string;
  private calls = 0;
  private active = 0;
  constructor(context: OwnedContext, settings: RuntimeSettings, check: () => void) {
    if (repositoryMode(settings, context) !== "AUTO_CODE") throw new RuntimeError("TOOL_REJECTED");
    this.generation = context.generation;
    this.approvalHash = digest(stableJson(settings.repositoryAccess));
    this.reader = new RepositoryReader(context.root, () => {
      check();
      this.guards.getStore()?.();
    });
  }
  /** Reserve after dedup, before durable intent or I/O; failures also consume the call budget. */
  reserve() {
    if (this.calls >= 256) throw new RuntimeError("RUNTIME_CAPACITY");
    this.calls++;
    if (this.active >= 4) throw new RuntimeError("RUNTIME_BUSY");
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  intent(tool: string, args: unknown): RepositoryToolIntent {
    if (!isRepositoryTool(tool)) throw new RuntimeError("TOOL_REJECTED");
    const body = {
      version: 1 as const,
      kind: "REPOSITORY_TOOL_INTENT" as const,
      generation: this.generation,
      approvalHash: this.approvalHash,
      tool,
      argumentsHash: digest(stableJson(args)),
      createdAt: new Date().toISOString(),
    };
    return { ...body, intentHash: digest(stableJson(body)) };
  }
  async execute(tool: string, args: unknown, guard: () => void) {
    if (!isRepositoryTool(tool)) throw new RuntimeError("TOOL_REJECTED");
    const input = validateToolArguments("AUTO_CODE", [], false, tool, args);
    return this.guards.run(guard, async () => {
      guard();
      let data: unknown, files: RepositoryExcerpt[];
      if (tool === "list_workspace_files") {
        data = await this.reader.list(input);
        files = [];
      } else if (tool === "search_workspace") {
        const found = await this.reader.search(input as { query: string; directory?: string });
        data = found;
        files = found.matches.map(excerpt);
      } else if (tool === "read_workspace_file") {
        const found = await this.reader.read(
          input as { path: string; offset?: number; expectedHash?: string },
        );
        data = found;
        files = [excerpt(found)];
      } else throw new RuntimeError("TOOL_REJECTED");
      guard();
      const text = JSON.stringify(data);
      if (Buffer.byteLength(text) > 8192) throw new RuntimeError("RUNTIME_CAPACITY");
      const result: ToolResult = { success: true, contentItems: [{ type: "inputText", text }] };
      const body = {
        version: 1 as const,
        kind: "REPOSITORY_TOOL_OBSERVATION" as const,
        generation: this.generation,
        approvalHash: this.approvalHash,
        tool,
        resultHash: digest(stableJson(result)),
        files,
      };
      const observation: RepositoryToolObservation = {
        ...body,
        observationHash: digest(stableJson(body)),
      };
      return { result, observation };
    });
  }
  async peerEvidence(args: unknown, guard: () => void): Promise<PeerEvidenceObservation> {
    const input = validateToolArguments("AUTO_CODE", [], true, "ask_peer", args);
    const evidence = input.evidence as { path: string; startLine: number; endLine: number }[];
    return this.guards.run(guard, async () => {
      const files: PeerEvidenceObservation["files"] = [];
      for (const item of evidence) {
        guard();
        // Reader.read checks the entire safe file and counts every byte against this reader's budget.
        const found = await this.reader.read({ path: item.path });
        guard();
        if (item.endLine > found.lineCount) throw new RuntimeError("TOOL_REJECTED");
        // Requested lines describe the question; byte/hash fields describe the actual verified fragment.
        files.push({
          ...excerpt(found),
          startLine: item.startLine,
          endLine: item.endLine,
          lineCount: found.lineCount,
        });
      }
      const body = {
        version: 1 as const,
        kind: "PEER_EVIDENCE_OBSERVATION" as const,
        generation: this.generation,
        approvalHash: this.approvalHash,
        purpose: "VERIFIED_FOR_PEER_QUESTION" as const,
        files,
      };
      return { ...body, observationHash: digest(stableJson(body)) };
    });
  }
}

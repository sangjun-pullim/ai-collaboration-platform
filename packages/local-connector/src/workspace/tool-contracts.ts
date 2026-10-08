import { repositoryFileLimit } from "./safe-file-reader.ts";
import { isHash } from "../contracts.ts";
import { RuntimeError, scopedNamespace, type RepositoryMode } from "../runtime-contracts.ts";
import { isSelectedPath } from "../runtime-file-policy.ts";
import {
  isRepositoryDirectory,
  isRepositoryFile,
  isRepositoryPath,
} from "./repository-path-policy.ts";

/** Only the three server-generated origin-role kinds may initiate a peer question. */
export const isOriginRoleRequestKind = (value: unknown): boolean =>
  value === "ORIGIN" || value === "CONTINUATION" || value === "RESUME";

export const selectedToolNames = ["read_workspace_file", "ask_peer"] as const;
export const repositoryToolNames = [
  "list_workspace_files",
  "search_workspace",
  "read_workspace_file",
] as const;
export const isRepositoryTool = (name: string): name is (typeof repositoryToolNames)[number] =>
  (repositoryToolNames as readonly string[]).includes(name);
export const scopedToolName = (name: string) => name.replace(`mcp__${scopedNamespace}__`, "");
export const isNativeRepositoryTool = (name: string) =>
  name.startsWith(`mcp__${scopedNamespace}__`) && isRepositoryTool(scopedToolName(name));
export function nativeToolNames(mode: RepositoryMode, peer: boolean): string[] {
  return [
    ...(mode === "AUTO_CODE" ? repositoryToolNames : ["read_workspace_file"]),
    ...(peer ? ["ask_peer"] : []),
  ].map((name) => `mcp__${scopedNamespace}__${name}`);
}
const safeDirectory = (value: unknown) =>
  isRepositoryPath(value, true) && (value === "" || isRepositoryDirectory(value));
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= repositoryFileLimit;
const query = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  Buffer.byteLength(value) <= 1024 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const question = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
function exact(
  input: unknown,
  required: Record<string, (value: unknown) => boolean>,
  optional: Record<string, (value: unknown) => boolean> = {},
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RuntimeError("TOOL_REJECTED");
  const args = input as Record<string, unknown>;
  if (
    Object.keys(args).some(
      (key) => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key),
    ) ||
    Object.entries(required).some(
      ([key, check]) => !Object.hasOwn(args, key) || !check(args[key]),
    ) ||
    Object.entries(optional).some(([key, check]) => Object.hasOwn(args, key) && !check(args[key]))
  )
    throw new RuntimeError("TOOL_REJECTED");
  return structuredClone(args);
}
export function validateToolArguments(
  mode: RepositoryMode,
  files: readonly { path: string }[] | null,
  peer: boolean,
  name: string,
  input: unknown,
): Record<string, unknown> {
  const path = (value: unknown) =>
    mode === "AUTO_CODE"
      ? typeof value === "string" && isRepositoryFile(value)
      : isSelectedPath(value) && (files === null || files.some((file) => file.path === value));
  if (name === "read_workspace_file")
    return exact(
      input,
      { path },
      mode === "AUTO_CODE" ? { offset: integer, expectedHash: isHash } : {},
    );
  if (mode === "AUTO_CODE" && name === "list_workspace_files") {
    const args = exact(
      input,
      {},
      {
        directory: safeDirectory,
        after: (value) =>
          typeof value === "string" && (isRepositoryFile(value) || isRepositoryDirectory(value)),
      },
    );
    if (
      typeof args.after === "string" &&
      (args.after.includes("/") ? args.after.slice(0, args.after.lastIndexOf("/")) : "") !==
        (args.directory ?? "")
    )
      throw new RuntimeError("TOOL_REJECTED");
    return args;
  }
  if (mode === "AUTO_CODE" && name === "search_workspace")
    return exact(input, { query }, { directory: safeDirectory });
  if (name === "ask_peer" && peer) {
    return exact(input, {
      question,
      evidence: (value) =>
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= 4 &&
        value.every((entry: unknown) => {
          const evidence = exact(entry, {
            path,
            startLine: (line) => Number.isSafeInteger(line) && Number(line) >= 1,
            endLine: (line) => Number.isSafeInteger(line) && Number(line) >= 1,
          });
          return Number(evidence.endLine) >= Number(evidence.startLine);
        }),
    });
  }
  throw new RuntimeError("TOOL_REJECTED");
}
export function repositoryTools(
  mode: RepositoryMode,
  files: readonly { path: string }[],
  peer: boolean,
) {
  const path =
    mode === "AUTO_CODE"
      ? { type: "string", minLength: 1, maxLength: 512 }
      : { type: "string", enum: files.map((file) => file.path) };
  const schema = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const tools =
    mode === "AUTO_CODE"
      ? [
          {
            name: "list_workspace_files",
            description: "List safe code and document paths within the approved repository.",
            inputSchema: schema(
              {
                directory: { type: "string", maxLength: 512 },
                after: { type: "string", minLength: 1, maxLength: 512 },
              },
              [],
            ),
          },
          {
            name: "search_workspace",
            description:
              "Search literal text in safe repository files; only returned matches are evidence.",
            inputSchema: schema(
              {
                query: { type: "string", minLength: 1, maxLength: 256 },
                directory: { type: "string", maxLength: 512 },
              },
              ["query"],
            ),
          },
          {
            name: "read_workspace_file",
            description: "Read a bounded UTF-8 excerpt from a safe approved repository file.",
            inputSchema: schema(
              {
                path,
                offset: { type: "integer", minimum: 0, maximum: repositoryFileLimit },
                expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
              ["path"],
            ),
          },
        ]
      : [
          {
            name: "read_workspace_file",
            description: "Read one selected unchanged public text file.",
            inputSchema: schema({ path }, ["path"]),
          },
        ];
  if (peer)
    tools.push({
      name: "ask_peer",
      description:
        "Submit a public question to the authorized cycle peer. Returns accepted/pending immediately.",
      inputSchema: schema(
        {
          question: { type: "string", minLength: 1, maxLength: 2000 },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: schema(
              {
                path,
                startLine: { type: "integer", minimum: 1 },
                endLine: { type: "integer", minimum: 1 },
              },
              ["path", "startLine", "endLine"],
            ),
          },
        },
        ["question", "evidence"],
      ),
    });
  return tools;
}

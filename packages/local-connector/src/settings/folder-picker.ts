import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { RootIdentity } from "../runtime-contracts.ts";
import { RuntimeFilePolicy } from "../runtime-file-policy.ts";

const maxOutputBytes = 8192;
const defaultTimeoutMs = 120000;
const folderScript = [
  'set selectedFolder to POSIX path of (choose folder with prompt "Select a project folder for your AI")',
  'if selectedFolder ends with "/" and length of selectedFolder > 1 then set selectedFolder to text 1 thru -2 of selectedFolder',
  "return selectedFolder",
].join("\n");

export type FolderPickerResult =
  | { status: "SELECTED"; root: RootIdentity }
  | { status: "CANCELLED" | "DENIED" | "TIMEOUT" | "UNSUPPORTED" | "FAILED" };

export interface FolderPickerExecutionOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  killSignal: "SIGKILL";
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}

export type FolderPickerExecute = (
  file: string,
  args: readonly string[],
  options: FolderPickerExecutionOptions,
) => Promise<{ stdout: string; stderr: string }>;

// Wait for close even when execFile reports an abort before the child exits.
const executeNative: FolderPickerExecute = (file, args, options) =>
  new Promise((accept, reject) => {
    let closed = false;
    let result: { error: Error | null; stdout: string; stderr: string } | undefined;
    const finish = () => {
      if (!closed || !result) return;
      if (result.error) {
        const error = result.error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: unknown;
        };
        // execFile supplies stderr separately; keep only bounded, private classification data.
        reject({
          code: error.code,
          killed: error.killed,
          signal: error.signal,
          stderr:
            typeof result.stderr === "string" && Buffer.byteLength(result.stderr) <= maxOutputBytes
              ? result.stderr
              : undefined,
        });
      } else accept({ stdout: result.stdout, stderr: result.stderr });
    };
    const child = execFile(file, [...args], options, (error, stdout, stderr) => {
      result = { error, stdout, stderr };
      finish();
    });
    child.once("close", () => {
      closed = true;
      finish();
    });
  });

function selectedPath(stdout: string): string {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > maxOutputBytes) throw new Error();
  const path = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!path || /[\0\r\n]/.test(path) || !isAbsolute(path) || resolve(path) !== path)
    throw new Error();
  return path;
}

function failureStatus(error: unknown): Exclude<FolderPickerResult["status"], "SELECTED"> {
  if (!error || typeof error !== "object") return "FAILED";
  const value = error as { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
  if (value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "FAILED";
  if (value.code === "ABORT_ERR") return "CANCELLED";
  if (value.code === "ETIMEDOUT" || (value.killed === true && value.signal === "SIGKILL"))
    return "TIMEOUT";
  if (value.code === "EACCES" || value.code === "EPERM") return "DENIED";
  if (typeof value.stderr !== "string" || Buffer.byteLength(value.stderr) > maxOutputBytes)
    return "FAILED";
  if (/\(-128\)/.test(value.stderr)) return "CANCELLED";
  if (/\(-(1743|10004)\)/.test(value.stderr)) return "DENIED";
  return "FAILED";
}

export async function pickFolder(
  options: { signal?: AbortSignal; timeoutMs?: number; execute?: FolderPickerExecute } = {},
): Promise<FolderPickerResult> {
  if (options.signal?.aborted) return { status: "CANCELLED" };
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > defaultTimeoutMs)
    return { status: "FAILED" };
  if (!options.execute && process.platform !== "darwin") return { status: "UNSUPPORTED" };

  const controller = new AbortController();
  let interrupted: "CANCELLED" | "TIMEOUT" | undefined;
  const interrupt = (status: "CANCELLED" | "TIMEOUT") => {
    interrupted ??= status;
    controller.abort();
  };
  const onAbort = () => interrupt("CANCELLED");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => interrupt("TIMEOUT"), timeoutMs);
  const check = () => {
    if (options.signal?.aborted) interrupt("CANCELLED");
    if (interrupted) throw new Error();
  };
  let selectionReceived = false;
  try {
    check();
    const { stdout } = await (options.execute ?? executeNative)(
      "/usr/bin/osascript",
      ["-e", folderScript],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        killSignal: "SIGKILL",
        signal: controller.signal,
        env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      },
    );
    selectionReceived = true;
    check();
    const path = selectedPath(stdout);
    const root = await RuntimeFilePolicy.root(path, check);
    if (root.path !== path) return { status: "FAILED" };
    await new RuntimeFilePolicy(root, []).assertUnchanged(check);
    check();
    return { status: "SELECTED", root };
  } catch (error) {
    return { status: interrupted ?? (selectionReceived ? "FAILED" : failureStatus(error)) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

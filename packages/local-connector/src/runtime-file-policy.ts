import { isAbsolute } from "node:path";
import { RuntimeError, type FileSnapshot, type RootIdentity } from "./runtime-contracts.ts";
import {
  assertSafeRoot,
  readSafeFile,
  resolveSafeRoot,
  secretPattern,
} from "./workspace/safe-file-reader.ts";

export function isSelectedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !isAbsolute(value) &&
    !/[\\\0\r\n]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !/^(?:\.git|\.codex|\.claude|\.agents|\.ssh|\.aws|\.config|node_modules|\.next|\.cache|cache|credentials?|auth(?:\.json)?|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i.test(
            part,
          ),
      )
  );
}
export function publicText(
  value: string,
  denied: readonly string[] = [],
  allowEmpty = false,
): string {
  const text = value.trim();
  if (
    (!text && !allowEmpty) ||
    Buffer.byteLength(text) > 8192 ||
    Array.from(text).length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
    secretPattern.test(text) ||
    denied.some((v) => v.length > 0 && text.includes(v)) ||
    /(?:PROVIDER_RAW_ERROR|Traceback \(most recent call|Error:\s|\/Users\/|\/private\/var\/|\/home\/)/.test(
      text,
    )
  )
    throw new RuntimeError("PUBLIC_TEXT_REJECTED");
  return text;
}
export class RuntimeFilePolicy {
  constructor(
    readonly root: RootIdentity,
    readonly files: readonly FileSnapshot[],
  ) {}
  static async root(input: string, check = () => {}) {
    return resolveSafeRoot(input, check);
  }
  static async select(
    input: string,
    paths: string[],
    check = () => {},
  ): Promise<RuntimeFilePolicy> {
    if (
      paths.length > 32 ||
      new Set(paths).size !== paths.length ||
      paths.some((p) => !isSelectedPath(p))
    )
      throw new RuntimeError("TOOL_REJECTED");
    const policy = new RuntimeFilePolicy(await this.root(input, check), []);
    const files: FileSnapshot[] = [];
    let total = 0;
    for (const path of paths) {
      const read = await policy.readSnapshot(path, check);
      check();
      total += read.snapshot.size;
      if (total > 512 * 1024) throw new RuntimeError("TOOL_REJECTED");
      files.push(read.snapshot);
    }
    return new RuntimeFilePolicy(policy.root, files);
  }
  async assertUnchanged(check = () => {}) {
    await this.checkRoot(check);
    for (const file of this.files) {
      await this.read(file.path, check);
      check();
    }
  }
  private async checkRoot(check: () => void) {
    await assertSafeRoot(this.root, check);
  }
  private async readSnapshot(path: string, check: () => void) {
    if (!isSelectedPath(path)) throw new RuntimeError("TOOL_REJECTED");
    return readSafeFile(this.root, path, check, "selected");
  }
  async read(path: string, check = () => {}): Promise<string> {
    const expected = this.files.find((file) => file.path === path);
    if (!expected) throw new RuntimeError("TOOL_REJECTED");
    const { text, snapshot } = await this.readSnapshot(path, check);
    check();
    if (JSON.stringify(snapshot) !== JSON.stringify(expected))
      throw new RuntimeError("SNAPSHOT_CHANGED");
    return text;
  }
}

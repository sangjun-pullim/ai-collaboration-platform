import { execFile } from "node:child_process";
import { relative, isAbsolute } from "node:path";
import { isAlias } from "../contracts.ts";
import { RuntimeFilePolicy, publicText } from "../runtime-file-policy.ts";
import type { FileSnapshot, RootIdentity } from "../runtime-contracts.ts";
import type { FolderPickerExecute } from "./folder-picker.ts";

const script = `on run argv
  set projectFolder to POSIX file (item 1 of argv)
  display dialog "이 폴더에서 필요한 코드를 AI가 자동으로 목록 조회·검색·읽기합니다. 개인 로그인과 AI 설정은 유지합니다. 비밀·인증·개인 지침 자료와 폴더 밖 경로는 제외하며 파일은 수정하지 않습니다. 생성한 답과 근거의 상대 경로 및 파일 hash가 채팅 기록에 남습니다." buttons {"취소", "자동 탐색 승인"} default button "자동 탐색 승인" cancel button "취소"
  set repositoryName to text returned of (display dialog "채팅방에 표시할 저장소 이름" default answer "공유 저장소" buttons {"취소", "다음"} default button "다음" cancel button "취소")
  set contextText to text returned of (display dialog "AI에게 전달할 공개 설명 (선택 사항)" default answer "" buttons {"취소", "확인"} default button "확인" cancel button "취소")
  set resultText to repositoryName & (ASCII character 30) & contextText & (ASCII character 30) & "AUTO_CODE"
  return resultText
end run`;
export type LocalScopeChoice =
  | {
      confirmed: true;
      repositoryAlias: string;
      files: FileSnapshot[];
      handoff: string;
      readMode?: "AUTO_CODE";
    }
  | { confirmed: false };
const executeNative: FolderPickerExecute = (file, args, options) =>
  new Promise((resolve, reject) => {
    let closed = false;
    let outcome: { error: Error | null; stdout: string; stderr: string } | undefined;
    const finish = () => {
      if (!closed || !outcome) return;
      if (outcome.error) reject(outcome.error);
      else resolve({ stdout: outcome.stdout, stderr: outcome.stderr });
    };
    const child = execFile(file, [...args], options, (error, stdout, stderr) => {
      outcome = { error, stdout, stderr };
      finish();
    });
    child.once("close", () => {
      closed = true;
      finish();
    });
  });

export async function confirmLocalScope(
  root: RootIdentity,
  options: { signal?: AbortSignal; execute?: FolderPickerExecute } = {},
): Promise<LocalScopeChoice> {
  if (options.signal?.aborted || (!options.execute && process.platform !== "darwin"))
    return { confirmed: false };
  const check = () => {
    if (options.signal?.aborted) throw new Error();
  };
  try {
    await new RuntimeFilePolicy(root, []).assertUnchanged(check);
    const result = await (options.execute ?? executeNative)(
      "/usr/bin/osascript",
      ["-e", script, root.path],
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 65536,
        killSignal: "SIGKILL",
        signal: options.signal ?? new AbortController().signal,
        env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      },
    );
    check();
    if (Buffer.byteLength(result.stdout) > 65536 || result.stdout.includes("\0"))
      return { confirmed: false };
    const parts = result.stdout.split("\u001e");
    if (parts.length !== 3 || !isAlias(parts[0])) return { confirmed: false };
    const handoff = publicText(parts[1], [root.path], true);
    if (parts[2] === "AUTO_CODE" || parts[2] === "AUTO_CODE\n") {
      if (result.stderr !== "") return { confirmed: false };
      await new RuntimeFilePolicy(root, []).assertUnchanged(check);
      return {
        confirmed: true,
        repositoryAlias: parts[0],
        files: [],
        handoff,
        readMode: "AUTO_CODE",
      };
    }
    const paths = parts[2]
      .trimEnd()
      .split("\n")
      .map((path) => {
        if (!isAbsolute(path)) throw new Error();
        return relative(root.path, path);
      });
    const files = await RuntimeFilePolicy.select(root.path, paths, check);
    check();
    return { confirmed: true, repositoryAlias: parts[0], files: [...files.files], handoff };
  } catch {
    return { confirmed: false };
  }
}

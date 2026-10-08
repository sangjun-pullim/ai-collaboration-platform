import { isAbsolute } from "node:path";

export function isRepositoryPath(value: unknown, allowRoot = false): value is string {
  return (
    typeof value === "string" &&
    ((allowRoot && value === "") ||
      (value.length > 0 &&
        value.length <= 512 &&
        !isAbsolute(value) &&
        !/[\\\0\r\n]/.test(value) &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== "..")))
  );
}
const protectedDirectory =
  /^(?:node_modules|vendor|build|dist|coverage|cache|target|out|bower_components|credentials?|secrets?|__generated__|__pycache__)$/i;
const protectedFile =
  /^(?:AGENTS\.md|CLAUDE\.md|CODEX\.md|mcp\.json|settings\.(?:json|jsonc|yaml|yml|toml)|(?:auth|authentication|credentials?|secrets?|tokens?|passwords?|api[._-]?keys?|access[._-]?tokens?|client[._-]?secrets?)(?:[._-].*)?|(?:settings|config)\.(?:local\.)?(?:claude|codex|mcp)\..*|(?:claude|codex|agent)[._-]settings(?:[._-].*)?)$/i;
const materialExtension = /\.(?:pem|key|p12|pfx|sqlite(?:3)?|db|der|crt|cer|keystore|jks)$/i;
const codeExtension =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|m|mm|php|sh|bash|zsh|sql|vue|svelte|html|css|scss|sass|less|graphql|gql|proto)$/i;
const documentExtension =
  /\.(?:md|mdx|txt|rst|adoc|json|jsonc|yaml|yml|toml|xml|ini|conf|properties|csv|tsv)$/i;
function safeParts(path: string) {
  return (
    isRepositoryPath(path) &&
    path.split("/").every((part) => !part.startsWith(".") && !materialExtension.test(part))
  );
}
export function isRepositoryDirectory(path: string) {
  return (
    safeParts(path) &&
    path
      .split("/")
      .every(
        (part) =>
          !protectedDirectory.test(part) &&
          !/^(?:AGENTS\.md|CLAUDE\.md|CODEX\.md|mcp\.json|auth\.json)$/i.test(part) &&
          !(documentExtension.test(part) && protectedFile.test(part)),
      )
  );
}
export function isRepositoryFile(path: string) {
  if (!safeParts(path)) return false;
  const parts = path.split("/");
  const name = parts.pop()!;
  if (parts.length && !isRepositoryDirectory(parts.join("/"))) return false;
  // Code in auth directories and ordinary authentication implementation files remain readable.
  if (/\.(?:min|bundle|generated)\./i.test(name)) return false;
  if (codeExtension.test(name)) return true;
  return (
    !protectedFile.test(name) &&
    (documentExtension.test(name) || /^(?:LICENSE|NOTICE|README|Dockerfile|Makefile)$/i.test(name))
  );
}

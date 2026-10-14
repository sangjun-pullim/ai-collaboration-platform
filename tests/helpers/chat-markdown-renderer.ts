import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { ComponentType } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import ts from "typescript";

const exports: Record<string, unknown> = {};
const source = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/chat-markdown.tsx", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
runInNewContext(
  source,
  {
    exports,
    URL,
    require(id: string) {
      if (id === "react/jsx-runtime") return jsxRuntime;
      if (id === "react-markdown") return { default: ReactMarkdown, defaultUrlTransform };
      if (id === "remark-gfm") return { default: remarkGfm };
      throw new Error(`Unexpected Markdown dependency ${id}`);
    },
  },
  { timeout: 1000 },
);

export const ChatMarkdown = exports.ChatMarkdown as ComponentType<{
  text: string;
  messageId: string;
}>;

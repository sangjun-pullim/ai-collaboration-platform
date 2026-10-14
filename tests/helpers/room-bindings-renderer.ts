import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { ComponentType } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import type { RoomGitBinding } from "../../src/features/device-binding/room-git-report.ts";

const exports: Record<string, unknown> = {};
const source = ts.transpileModule(
  readFileSync("src/features/device-binding/room-bindings.tsx", "utf8"),
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
    Date,
    require(id: string) {
      if (id === "react/jsx-runtime") return jsxRuntime;
      if (id === "../../components/ui/badge") return { Badge: "span" };
      if (id === "../room-access/access.module.css")
        return { default: { list: "list", code: "code" } };
      throw new Error(`Unexpected panel dependency ${id}`);
    },
  },
  { timeout: 1000 },
);
export const RoomBindings = exports.RoomBindings as ComponentType<{ bindings: RoomGitBinding[] }>;

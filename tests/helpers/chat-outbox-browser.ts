import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Page } from "@playwright/test";
/** Execute the production modules against the browser's real IndexedDB implementation. */
export async function installOutboxHarness(page: Page) {
  const names = ["source-contracts", "contracts", "chat-outbox"];
  const code = Object.fromEntries(
    names.map((name) => [
      name,
      ts.transpileModule(
        readFileSync(`src/features/investigation-coordinator/${name}.ts`, "utf8"),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
      ).outputText,
    ]),
  );
  await page.evaluate((code) => {
    const modules: Record<string, Record<string, unknown>> = {};
    function load(name: string): Record<string, unknown> {
      if (modules[name]) return modules[name];
      const exports: Record<string, unknown> = {};
      modules[name] = exports;
      new Function("exports", "require", code[name])(exports, (path: string) =>
        load(
          path
            .replace(/^\.\//, "")
            .replace(/\.ts$/, "")
            .replace(/^workflow\//, ""),
        ),
      );
      return exports;
    }
    const production = load("chat-outbox") as {
      IndexedSpeechOutbox: new (
        factory?: () => IDBFactory,
        now?: () => number,
        storage?: () => Storage,
      ) => unknown;
    };
    Object.assign(globalThis, {
      outbox: new production.IndexedSpeechOutbox(),
      Outbox: production.IndexedSpeechOutbox,
    });
  }, code);
}

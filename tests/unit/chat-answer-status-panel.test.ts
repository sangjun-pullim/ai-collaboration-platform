import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { answerStatuses } from "../../src/features/investigation-coordinator/chat-presentation.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
type Node = { type: unknown; props: Record<string, unknown> };
function all(node: unknown): Node[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(all);
  const item = node as Node;
  if (typeof item.type === "function") return all(item.type(item.props));
  return [item, ...all(item.props?.children)];
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object") return "";
  const item = node as Node;
  return typeof item.type === "function" ? text(item.type(item.props)) : text(item.props?.children);
}
test("should keep UNKNOWN REQUESTED one line and never reopen details on polling", () => {
  let open = false;
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(
    readFileSync("src/features/investigation-coordinator/chat-answer-status-panel.tsx", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react")
        return {
          useState: () => [
            open,
            (value: boolean) => {
              open = value;
            },
          ],
        };
      if (name.endsWith("/dialog"))
        return {
          Dialog: (props: Record<string, unknown>) =>
            jsx("dialog", { ...props, children: props.children }),
          DialogTrigger: "trigger",
          DialogContent: (props: Record<string, unknown>) => (open ? jsx("content", props) : null),
          DialogTitle: "h2",
          DialogDescription: "p",
        };
      if (name.endsWith("/button")) return { Button: "button" };
      if (name === "./chat-timeline")
        return {
          ChatAnswerStatus: () =>
            jsx("p", {
              children:
                "실행 결과가 확인되지 않았습니다. 성공이나 중단이 확인되지 않은 상태입니다.",
            }),
        };
      throw new Error(`Unexpected panel dependency ${name}`);
    },
  });
  const component = exports.ChatAnswerStatusPanel as (props: Record<string, unknown>) => Node;
  const projected = answerStatuses({
    ...fixture.history,
    historicalRuns: [],
    runs: [{ ...fixture.history.runs[0], state: "UNKNOWN" }],
    observedAt: Date.now(),
    now: Date.now(),
    role: "participant",
    cancelReceipts: [
      {
        requestId: fixture.history.runs[0].requestId,
        cycleId: fixture.history.runs[0].cycleId,
        agentId: fixture.history.runs[0].agentId,
        epoch: 1,
        state: "REQUESTED",
      },
    ],
  });
  const render = () =>
    component({ statuses: projected.statuses, children: jsx("button", { children: "중단 제어" }) });
  const initial = render();
  assert.match(String(initial.props.className), /h-10/);
  assert.equal(all(initial).filter((item) => item.type === "button").length, 1);
  assert.doesNotMatch(text(initial), /실행 결과가 확인되지 않았습니다/);
  const dialog = all(initial).find((item) => item.type === "dialog")!;
  (dialog.props.onOpenChange as (value: boolean) => void)(true);
  assert.match(text(render()), /성공이나 중단이 확인되지/);
  (
    all(render()).find((item) => item.type === "dialog")!.props.onOpenChange as (
      value: boolean,
    ) => void
  )(false);
  for (let index = 0; index < 3; index++)
    assert.doesNotMatch(text(render()), /실행 결과가 확인되지 않았습니다|중단 제어/);
  assert.equal(projected.statuses[0].state, "UNKNOWN");
  assert.equal(projected.statuses[0].cancelReceiptState, "REQUESTED");
});

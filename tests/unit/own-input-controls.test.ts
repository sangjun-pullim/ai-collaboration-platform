import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as controlState from "../../src/features/investigation-coordinator/own-input-control-state.ts";

type Node = { type: unknown; props: Record<string, unknown> };
const source = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/own-input-controls.tsx", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
function elements(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return [node, ...elements(node.props?.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text((value as Node).props?.children);
  return typeof value === "string" ? value : "";
}
test("should associate two owned AI controls with their distinct repositories and shared session alias", () => {
  const bindings: contracts.PublicBinding[] = ["frontend", "backend"].map(
    (repositoryAlias, index) => ({
      agentId: `00000000-0000-4000-8000-00000000000${index + 2}`,
      ownerAlias: "owner",
      sessionAlias: "shared-session",
      repositoryAlias,
      runtime: "codex",
      bindingEpoch: 1,
      owned: true,
      reportedReady: true,
      validUntil: null,
    }),
  );
  const states = Object.fromEntries(
    bindings.map((binding) => [
      binding.agentId,
      {
        agentId: binding.agentId,
        bindingEpoch: 1,
        revision: 1,
        paused: false,
        appliedRevision: 1,
        appliedEpoch: 1,
        appliedAt: "2026-10-06T00:00:00Z",
      },
    ]),
  );
  let stateIndex = 0;
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const exports: { OwnInputControls?: (props: unknown) => Node } = {};
  runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react")
        return {
          useState(initial: unknown) {
            return [stateIndex++ === 0 ? states : initial, () => {}];
          },
          useRef(current: unknown) {
            return { current };
          },
          useEffect() {},
          useLayoutEffect(effect: () => void) {
            effect();
          },
        };
      if (name === "./contracts") return contracts;
      if (name === "./own-input-control-state") return controlState;
      if (name === "./polling-policy") return { pollingDelay: () => 10000 };
      if (name === "./investigation-client")
        return {
          callInvestigation: () => {
            throw new Error("Unexpected network call");
          },
        };
      if (name === "../../components/ui/button") return { Button: "button" };
      throw new Error(`Unexpected controls dependency ${name}`);
    },
  });
  assert.ok(exports.OwnInputControls);
  const nodes = elements(
    exports.OwnInputControls({
      userId: "00000000-0000-4000-8000-000000000001",
      roomId: "00000000-0000-4000-8000-000000000004",
      bindings,
    }),
  );
  const buttons = nodes.filter((node) => node.type === "button");
  assert.equal(buttons.length, 2);
  const names = buttons.map((button) => {
    const labels = String(button.props["aria-labelledby"] ?? "")
      .split(" ")
      .filter(Boolean);
    return (
      button.props["aria-label"] ??
      (labels.length
        ? labels.map((id) => text(nodes.find((node) => node.props.id === id))).join(" ")
        : text(button))
    );
  });
  assert.notEqual(names[0], names[1]);
  for (let index = 0; index < bindings.length; index++) {
    assert.match(String(names[index]), new RegExp(bindings[index].repositoryAlias));
    assert.match(String(names[index]), /shared-session/);
    assert.match(String(names[index]), /일시정지/);
    assert.equal(text(buttons[index]), "내 AI 새 답변 일시정지");
    const status = nodes.find((node) => node.props.id === buttons[index].props["aria-describedby"]);
    assert.equal(status?.props.role, "status");
    const label = nodes.find((node) => node.props.id === status?.props["aria-labelledby"]);
    assert.match(text(label), new RegExp(bindings[index].repositoryAlias));
    assert.match(text(label), /shared-session/);
    assert.equal(text(status), "재개 적용 보고");
  }
});

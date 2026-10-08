import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { shouldSendOnEnter } from "../../src/features/investigation-coordinator/chat-presentation.ts";

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(node: unknown): Node[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const item = node as Node;
  return [item, ...nodes(item.props?.children)];
}
function harness() {
  const refs: { current: unknown }[] = [];
  let index = 0,
    effects: (() => void)[] = [];
  let requests = 0,
    prevented = 0,
    focuses = 0,
    submissions = 0;
  let resolve: (value: boolean) => void = () => {};
  const input = {
    disabled: false,
    focus() {
      focuses++;
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const exported: { ChatComposer?: (props: unknown) => Node } = {};
  const source = ts.transpileModule(
    readFileSync("src/features/investigation-coordinator/chat-composer.tsx", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(source, {
    exports: exported,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react")
        return {
          useRef(initial: unknown) {
            const slot = index++;
            return refs[slot] ?? (refs[slot] = { current: initial });
          },
          useLayoutEffect(effect: () => void) {
            effects.push(effect);
          },
        };
      if (name === "./chat-presentation") return { shouldSendOnEnter };
      if (name === "../../components/ui/button") return { Button: "button" };
      if (name === "../../components/ui/textarea") return { Textarea: "textarea" };
      if (name === "lucide-react") return { Send: "icon" };
      throw new Error(`Unexpected composer dependency ${name}`);
    },
  });
  const props = {
    mode: "ask",
    onMode() {},
    draft: "직접 질문",
    onDraft() {},
    targets: [],
    targetValue: "saved-agent",
    stale: false,
    onTarget() {},
    disabled: false,
    busy: false,
    pending: false,
    onSubmit: async () => {
      submissions++;
      return new Promise<boolean>((done) => {
        resolve = done;
      });
    },
  };
  function render() {
    index = 0;
    effects = [];
    const tree = exported.ChatComposer!(props);
    const area = nodes(tree).find((n) => n.type === "textarea")!;
    input.disabled = Boolean(area.props.disabled);
    (area.props.ref as { current: unknown }).current = input;
    effects.forEach((effect) => effect());
    return tree;
  }
  function key(tree: Node, { shiftKey = false, isComposing = false, keyCode = 13 } = {}) {
    const area = nodes(tree).find((n) => n.type === "textarea")!;
    (area.props.onKeyDown as (value: unknown) => void)({
      key: "Enter",
      shiftKey,
      nativeEvent: { isComposing, keyCode },
      preventDefault() {
        prevented++;
      },
      currentTarget: {
        form: {
          requestSubmit() {
            requests++;
          },
        },
      },
    });
  }
  return {
    render,
    key,
    props,
    requests: () => requests,
    prevented: () => prevented,
    focuses: () => focuses,
    submissions: () => submissions,
    resolve: (value: boolean) => resolve(value),
    submit(tree: Node) {
      return (tree.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
    },
  };
}

test("should submit a named AI question on Enter without a per-question checkbox", async () => {
  const h = harness(),
    tree = h.render();
  assert.equal(
    nodes(tree).some((node) => node.props.type === "checkbox"),
    false,
  );
  assert.equal(
    nodes(tree).find(
      (node) => node.type === "select" && node.props["aria-label"] === "직접 질문 대상",
    )?.props.value,
    "saved-agent",
  );
  h.key(tree);
  assert.equal(h.requests(), 1);
  assert.equal(h.prevented(), 1);
  const sent = h.submit(tree);
  assert.equal(h.submissions(), 1);
  h.resolve(true);
  await sent;
  assert.equal(h.focuses(), 1);
  h.render();
  assert.equal(h.focuses(), 1);
});
test("should retain composition and Shift Enter without requesting transmission", () => {
  const h = harness(),
    tree = h.render();
  const area = nodes(tree).find((node) => node.type === "textarea")!;
  (area.props.onCompositionStart as () => void)();
  h.key(tree);
  h.key(tree, { isComposing: true });
  (area.props.onCompositionEnd as () => void)();
  h.key(tree, { keyCode: 229 });
  h.key(tree, { shiftKey: true });
  assert.equal(h.requests(), 0);
  assert.equal(h.prevented(), 0);
  h.key(tree);
  assert.equal(h.requests(), 1);
});
test("should defer successful submit focus until the busy input becomes enabled", async () => {
  const h = harness();
  const sent = h.submit(h.render());
  h.props.busy = true;
  h.props.disabled = true;
  h.render();
  h.resolve(true);
  await sent;
  assert.equal(h.focuses(), 0);
  h.props.busy = false;
  h.props.disabled = false;
  h.props.draft = "";
  h.render();
  assert.equal(h.focuses(), 1);
});
test("should retain pending input and target disable without allowing an Enter transmission", () => {
  const h = harness();
  h.props.pending = true;
  h.props.disabled = true;
  const tree = h.render();
  assert.equal(nodes(tree).find((node) => node.type === "textarea")?.props.disabled, true);
  assert.equal(
    nodes(tree).find(
      (node) => node.type === "select" && node.props["aria-label"] === "직접 질문 대상",
    )?.props.disabled,
    true,
  );
  assert.equal(nodes(tree).find((node) => node.type === "button")?.props.disabled, true);
  h.key(tree);
  assert.equal(h.requests(), 0);
});
test("should leave failed submit focus with the error owner and never focus on later polling renders", async () => {
  const h = harness();
  const failed = h.submit(h.render());
  h.resolve(false);
  await failed;
  h.render();
  assert.equal(h.focuses(), 0);
});

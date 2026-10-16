import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { shouldSendOnEnter } from "../../src/features/investigation-coordinator/chat-presentation.ts";
import type { PublicBinding } from "../../src/features/investigation-coordinator/contracts.ts";

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
      if (name === "next/link") return { default: "a" };
      throw new Error(`Unexpected composer dependency ${name}`);
    },
  });
  const props = {
    roomId: "00000000-0000-4000-8000-000000000003",
    readinessUnconfirmed: false,
    mode: "ask",
    onMode() {},
    draft: "직접 질문",
    onDraft() {},
    targets: [] as PublicBinding[],
    target: undefined as PublicBinding | undefined,
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

test("should offer room AI settings when no responder is ready without enabling a question", () => {
  const h = harness();
  h.props.disabled = true;
  const tree = h.render();
  const link = nodes(tree).find((node) => node.type === "a")!;
  assert.ok(link);
  assert.equal(link.props.href, `/app/connections?room=${h.props.roomId}#ai-settings`);
  assert.equal(link.props.children, "이 방의 AI 설정");
  assert.ok(nodes(tree).some((node) => node.props.children === "응답 준비된 AI가 없습니다."));
  assert.ok(
    nodes(tree).some((node) => node.props.children === "PC 연결 후 AI와 폴더 설정을 마치세요."),
  );
  assert.equal(nodes(tree).find((node) => node.type === "button")!.props.disabled, true);
  h.key(tree);
  assert.equal(h.requests(), 0);
});

test("should avoid claiming missing settings when readiness is unconfirmed", () => {
  const h = harness();
  h.props.readinessUnconfirmed = true;
  const tree = h.render();
  assert.ok(nodes(tree).some((node) => node.props.children === "AI 응답 준비 확인 필요"));
  assert.ok(!nodes(tree).some((node) => node.props.children === "응답 준비된 AI가 없습니다."));
  assert.ok(nodes(tree).some((node) => node.type === "a"));
});

test("should retain the compact composer without setup links for own or peer ready targets and speech", () => {
  const h = harness();
  const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
  for (const owned of [true, false]) {
    h.props.targets = [{ ...fixture.history.bindings[0], owned }];
    assert.ok(!nodes(h.render()).some((node) => node.type === "a"));
  }
  h.props.targets = [];
  h.props.mode = "speak";
  assert.ok(!nodes(h.render()).some((node) => node.type === "a"));
});

test("should retain complete target identity in selection and a concise readiness hint", () => {
  const h = harness();
  const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
  const own: PublicBinding = { ...fixture.history.bindings[0], owned: true };
  const peer = { ...own, owned: false, agentId: "00000000-0000-4000-8000-000000000099" };
  h.props.targets = [own, peer];
  h.props.target = own;
  h.props.targetValue = own.agentId;
  const tree = h.render();
  const optionText = (agentId: string) =>
    (
      nodes(tree).find((node) => node.type === "option" && node.props.value === agentId)!.props
        .children as string[]
    ).join("");
  const identity = `${own.ownerAlias} · ${own.runtime} · ${own.repositoryAlias} · ${own.sessionAlias}`;
  assert.equal(optionText(own.agentId), `내 AI · ${identity}`);
  assert.equal(optionText(peer.agentId), identity);
  assert.equal(tree.props["aria-label"], "AI에게 질문");
  assert.equal(
    nodes(tree).find((node) => node.type === "button")!.props["aria-label"],
    "AI에 질문 보내기",
  );
  assert.ok(
    nodes(tree).some(
      (node) =>
        typeof node.props.children === "string" && node.props.children.includes("응답 준비 보고"),
    ),
  );
  assert.equal(
    nodes(tree).find((node) => node.props["aria-label"] === "직접 질문 대상")!.props.value,
    own.agentId,
  );
});

test("should include the visible submit caption in its accessible name for each sending mode", () => {
  const h = harness();
  for (const mode of ["ask", "speak"]) {
    h.props.mode = mode;
    const button = nodes(h.render()).find((node) => node.type === "button")!;
    const caption = (button.props.children as unknown[])
      .filter((child): child is string => typeof child === "string")
      .join("");
    assert.ok(caption.length > 0);
    assert.ok((button.props["aria-label"] as string).includes(caption));
  }
});

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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as command from "../../src/features/device-binding/local-connection-command.ts";

type Node = { type: unknown; props: Record<string, unknown> };
const nodes = (value: unknown): Node[] =>
  Array.isArray(value)
    ? value.flatMap(nodes)
    : value && typeof value === "object"
      ? [value as Node, ...nodes((value as Node).props?.children)]
      : [];
const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(text).join("")
    : value && typeof value === "object"
      ? text((value as Node).props?.children)
      : String(value ?? "");
const userId = "11111111-1111-4111-8111-111111111111",
  roomId = "22222222-2222-4222-8222-222222222222";
const manifest = {
  version: 1,
  code: {
    path: `/local-connection/connector-${"a".repeat(64)}.tar.gz`,
    sha256: "a".repeat(64),
    bytes: 100,
  },
  bootstrap: {
    path: `/local-connection/bootstrap-${"b".repeat(64)}.sh`,
    sha256: "b".repeat(64),
    bytes: 100,
  },
};

function fixture(saved = new Map<string, string>()) {
  const slots: unknown[] = [],
    effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const listeners = new Set<(event: { key: string | null }) => void>();
  const copies: string[] = [];
  let cursor = 0,
    revision = 0,
    uuids = 0;
  let queued: (() => void)[] = [];
  const faults = { read: false, write: false, preparing: undefined as Promise<void> | undefined };
  const storage = {
    getItem(key: string) {
      if (faults.read) throw Error("denied");
      return saved.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (faults.write) throw Error("denied");
      saved.set(key, value);
    },
  };
  const source = ts.transpileModule(
    readFileSync("src/features/device-binding/local-connection-guide.tsx", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(source, {
    exports,
    AbortController,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    crypto: {
      randomUUID: () => `12345678-1234-4123-8123-${(++uuids).toString().padStart(12, "0")}`,
    },
    fetch: async () =>
      new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }),
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copies.push(value);
        },
      },
    },
    window: {
      localStorage: storage,
      addEventListener: (_name: string, listener: (e: { key: string | null }) => void) =>
        listeners.add(listener),
      removeEventListener: (_name: string, listener: (e: { key: string | null }) => void) =>
        listeners.delete(listener),
    },
    require(name: string) {
      if (name === "react/jsx-runtime")
        return {
          jsx: (type: unknown, props: unknown) => ({ type, props }),
          jsxs: (type: unknown, props: unknown) => ({ type, props }),
        };
      if (name === "react")
        return {
          useState(initial: unknown) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = initial;
            return [
              slots[index],
              (value: unknown) => {
                slots[index] =
                  typeof value === "function"
                    ? (value as (old: unknown) => unknown)(slots[index])
                    : value;
                revision++;
              },
            ];
          },
          useRef(initial: unknown) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = { current: initial };
            return slots[index];
          },
          useEffect(callback: () => (() => void) | void, deps: unknown[]) {
            const index = cursor++;
            if (!effects[index] || deps.some((value, i) => value !== effects[index].deps[i])) {
              queued.push(() => {
                effects[index]?.cleanup?.();
                effects[index] = { deps, cleanup: callback() ?? undefined };
              });
            }
          },
        };
      if (name === "./local-connection-command")
        return {
          ...command,
          nextConnectionSelection: async (
            ...args: Parameters<typeof command.nextConnectionSelection>
          ) => {
            await faults.preparing;
            return command.nextConnectionSelection(...args);
          },
        };
      if (name.endsWith("/button")) return { Button: "button" };
      if (name.endsWith("/input")) return { Input: "input" };
      throw Error(`Unexpected guide dependency ${name}`);
    },
  });
  const props = {
    origin: "https://app.example",
    userId,
    roomId,
    rooms: [{ roomId, organizationId: userId, roomTitle: "Room", organizationName: "Org" }],
    onRoomChange() {},
  };
  let tree: Node;
  const render = () => {
    cursor = 0;
    queued = [];
    tree = (exports.LocalConnectionGuide as (p: unknown) => Node)(props);
    queued.forEach((effect) => effect());
    return tree;
  };
  const settle = async () => {
    let stable = 0;
    for (let i = 0; i < 80 && stable < 3; i++) {
      const before = revision;
      render();
      await new Promise((resolve) => setTimeout(resolve, 2));
      stable = before === revision ? stable + 1 : 0;
    }
    render();
  };
  const button = (label: string) =>
    nodes(tree).find((n) => n.type === "button" && text(n) === label)!;
  const click = async (label: string) => {
    const b = button(label);
    assert.ok(b);
    assert.ok(!b.props.disabled);
    await (b.props.onClick as () => Promise<void> | void)();
    render();
  };
  const choose = async () => {
    await click("새 승인으로 다시 연결");
    const checkbox = nodes(tree).find((n) => n.props.type === "checkbox")!;
    (checkbox.props.onChange as (e: unknown) => void)({ target: { checked: true } });
    render();
  };
  const value = () => String(nodes(tree).find((n) => n.type === "textarea")?.props.value ?? "");
  return {
    saved,
    faults,
    copies,
    props,
    render,
    settle,
    click,
    choose,
    button,
    value,
    uuids: () => uuids,
    event: (key: string | null) => {
      listeners.forEach((listener) => listener({ key }));
      render();
    },
    close: () => effects.forEach((effect) => effect?.cleanup?.()),
  };
}

test("should create recovery only after explicit confirmation and reuse it across refresh and the next recovery", async () => {
  const f = fixture();
  try {
    await f.settle();
    assert.ok(f.value());
    assert.equal(f.uuids(), 0);
    await f.click("새 승인으로 다시 연결");
    assert.equal(f.value(), "");
    assert.equal(f.button("새 승인 명령 준비").props.disabled, true);
    await f.click("취소");
    await f.choose();
    await f.click("새 승인 명령 준비");
    await f.settle();
    const first = f.value();
    await f.click("연결 명령 복사");
    await f.click("연결 명령 복사");
    assert.deepEqual(f.copies, [first, first]);
    assert.equal(f.uuids(), 1);
    const key = command.connectionSelectionKey(f.props.origin, userId, roomId);
    const selected = await command.readConnectionSelection(
      f.saved.get(key)!,
      f.props.origin,
      userId,
      roomId,
    );
    const refreshed = fixture(f.saved);
    try {
      await refreshed.settle();
      assert.equal(refreshed.value(), first);
      assert.equal(refreshed.uuids(), 0);
    } finally {
      refreshed.close();
    }
    await f.choose();
    await f.click("새 승인 명령 준비");
    await f.settle();
    const next = await command.readConnectionSelection(
      f.saved.get(key)!,
      f.props.origin,
      userId,
      roomId,
    );
    assert.equal(next.chain[1].previousProfile, selected.chain[0].profile);
  } finally {
    f.close();
  }
});

for (const fault of ["read", "write", "malformed", "tabs", "preparing"] as const)
  test(`should withhold stale copy for ${fault} and never create a generation from load failure`, async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    let preparation: Promise<void> | undefined;
    try {
      const key = command.connectionSelectionKey(f.props.origin, userId, roomId);
      if (fault === "read") f.faults.read = true;
      if (fault === "malformed") f.saved.set(key, "corrupt");
      await f.settle();
      if (fault === "write" || fault === "preparing") {
        await f.choose();
        const staleCopy = f.button("연결 명령 복사").props.onClick as () => Promise<void>;
        if (fault === "write") f.faults.write = true;
        else
          f.faults.preparing = new Promise<void>((resolve) => {
            release = resolve;
          });
        preparation = (f.button("새 승인 명령 준비").props.onClick as () => Promise<void>)();
        f.render();
        await staleCopy();
        assert.equal(f.value(), "");
        release?.();
        await preparation;
        await f.settle();
      }
      if (fault === "tabs") {
        const staleCopy = f.button("연결 명령 복사").props.onClick as () => Promise<void>;
        const current = await command.readConnectionSelection(null, f.props.origin, userId, roomId);
        f.saved.set(
          key,
          JSON.stringify(
            await command.nextConnectionSelection(current, "12345678-1234-4123-8123-123456789abc"),
          ),
        );
        f.event(key);
        await staleCopy();
      }
      assert.equal(f.copies.length, 0);
      if (fault !== "preparing") assert.equal(f.value(), "");
      if (fault === "read" || fault === "malformed" || fault === "tabs") assert.equal(f.uuids(), 0);
      if (fault === "tabs") {
        await f.click("현재 선택 다시 확인");
        await f.settle();
        assert.ok(f.value());
      }
    } finally {
      release?.();
      await preparation;
      f.close();
    }
  });

test("should keep recovery selection isolated when the origin user or authorized room changes", async () => {
  const f = fixture();
  try {
    await f.settle();
    await f.choose();
    await f.click("새 승인 명령 준비");
    await f.settle();
    const recovered = f.value(),
      original = [...f.saved.entries()];
    f.props.userId = "33333333-3333-4333-8333-333333333333";
    f.render();
    assert.equal(f.value(), "");
    await f.settle();
    assert.notEqual(f.value(), recovered);
    f.props.origin = "https://other.example";
    f.render();
    assert.equal(f.value(), "");
    await f.settle();
    assert.notEqual(f.value(), recovered);
    f.props.roomId = "44444444-4444-4444-8444-444444444444";
    f.props.rooms[0].roomId = f.props.roomId;
    f.render();
    assert.equal(f.value(), "");
    await f.settle();
    assert.notEqual(f.value(), recovered);
    assert.deepEqual([...f.saved.entries()], original);
    assert.equal(f.uuids(), 1);
  } finally {
    f.close();
  }
});

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

function fixture(saved = new Map<string, string>(), extra: Record<string, unknown> = {}) {
  const slots: unknown[] = [],
    effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const listeners = new Set<(event: { key: string | null }) => void>();
  const copies: string[] = [];
  let cursor = 0,
    revision = 0,
    uuids = 0;
  let queued: (() => void)[] = [];
  const faults = {
    clipboard: false,
    lifetime: 1800000,
    issue: undefined as Promise<void> | undefined,
    read: false,
    write: false,
    preparing: undefined as Promise<void> | undefined,
  };
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
    AbortSignal,
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
          if (faults.clipboard) throw new Error("clipboard unavailable");
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
      if (name === "../connection-setup/setup-status") return { SetupStatus: "setup-status" };
      if (name === "../connection-setup/setup-controller")
        return {
          requestSetup: async (_action: string, body: { requestId: string }) => {
            await faults.issue;
            return {
              requestId: body.requestId,
              created: true,
              reissueRequired: false,
              expiresAt: new Date(Date.now() + faults.lifetime).toISOString(),
              key: "c".repeat(64),
              payloadHash: "d".repeat(64),
            };
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
    ...extra,
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
    assert.equal(f.value(), "");
    assert.equal(f.uuids(), 0);
    await f.click("새 승인으로 다시 연결");
    assert.equal(f.value(), "");
    assert.equal(f.button("새 승인 명령 준비").props.disabled, true);
    await f.click("취소");
    await f.choose();
    await f.click("새 승인 명령 준비");
    await f.settle();
    await f.click("연결 명령 복사");
    const first = f.value();
    await f.click("연결 명령 복사");
    assert.deepEqual(f.copies, [first, first]);
    assert.equal(f.uuids(), 2);
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
      assert.equal(refreshed.value(), "");
      await refreshed.click("연결 명령 복사");
      assert.equal(refreshed.value(), first);
      assert.equal(refreshed.uuids(), 1);
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
        assert.equal(f.value(), "");
        await f.click("연결 명령 복사");
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
    await f.click("연결 명령 복사");
    const original = [...f.saved.entries()];
    f.props.userId = "33333333-3333-4333-8333-333333333333";
    f.render();
    assert.equal(f.value(), "");
    await f.settle();
    assert.equal(f.value(), "");
    f.props.origin = "https://other.example";
    f.render();
    assert.equal(f.value(), "");
    await f.settle();
    assert.equal(f.value(), "");
    f.props.roomId = "44444444-4444-4444-8444-444444444444";
    f.props.rooms[0].roomId = f.props.roomId;
    f.render();
    assert.equal(f.value(), "");
    await f.settle();
    assert.equal(f.value(), "");
    assert.deepEqual([...f.saved.entries()], original);
    assert.equal(f.uuids(), 2);
  } finally {
    f.close();
  }
});

test("should keep copy first and command identity stable when guidance becomes secondary", async () => {
  const f = fixture(undefined, {
    showRoomSelection: false,
    deviceAliasHint: "내 Mac",
    deviceIdHint: userId,
  });
  try {
    await f.settle();
    const tree = f.render();
    const copy = f.button("연결 명령 복사");
    assert.equal(copy.props.variant, "default");
    assert.ok(nodes(tree).indexOf(copy) < nodes(tree).findIndex((node) => node.type === "input"));
    const details = nodes(tree).find(
      (node) => node.props["aria-label"] === "명령 직접 복사 영역" && text(node).includes(userId),
    )!;
    assert.ok(details);
    assert.equal(details.props.hidden, true);
    await f.click("연결 명령 복사");
    const initial = f.value();
    (f.props as Record<string, unknown>).prominent = false;
    await f.settle();
    assert.equal(f.button("연결 명령 복사").props.variant, "outline");
    assert.equal(f.value(), initial);
    await f.click("연결 명령 복사");
    assert.deepEqual(f.copies, [initial, initial]);
  } finally {
    f.close();
  }
});

test("should discard an issue result after changing room and never persist its key", async () => {
  const f = fixture();
  try {
    await f.settle();
    let release!: () => void;
    f.faults.issue = new Promise((resolve) => {
      release = resolve;
    });
    const copying = (f.button("연결 명령 복사").props.onClick as () => Promise<void>)();
    f.props.roomId = "44444444-4444-4444-8444-444444444444";
    f.props.rooms[0].roomId = f.props.roomId;
    f.render();
    release();
    await copying;
    await f.settle();
    assert.equal(f.copies.length, 0);
    assert.equal(f.value(), "");
    assert.equal(f.saved.size, 0);
  } finally {
    f.close();
  }
});
test("should retain direct copy after clipboard rejection without making recovery", async () => {
  const f = fixture();
  try {
    await f.settle();
    f.faults.clipboard = true;
    await f.click("연결 명령 복사");
    assert.ok(f.value());
    assert.equal(f.saved.size, 0);
    assert.equal(f.copies.length, 0);
  } finally {
    f.close();
  }
});

test("should renew expired launch tracking without changing the saved recovery generation", async () => {
  const f = fixture();
  try {
    await f.settle();
    f.faults.lifetime = -1;
    await f.click("연결 명령 복사");
    await f.settle();
    assert.ok(f.button("새 명령 복사"));
    const issued = f.uuids();
    f.faults.lifetime = 1800000;
    await f.click("새 명령 복사");
    await f.settle();
    assert.equal(f.uuids(), issued + 1);
    assert.equal(f.saved.size, 0);
    assert.equal(f.copies.length, 2);
  } finally {
    f.close();
  }
});

test("should keep advanced recovery and raw command out of the default connection task", async () => {
  const f = fixture();
  try {
    await f.settle();
    const tree = f.render();
    assert.equal(nodes(tree).filter((n) => n.type === "details").length, 0);
    const advanced = nodes(tree).find((n) => n.props["aria-label"] === "연결 추가 옵션")!;
    assert.ok(advanced);
    assert.equal(advanced.props.hidden, true);
    await f.click("연결 옵션");
    assert.equal(
      nodes(f.render()).find((n) => n.props["aria-label"] === "연결 추가 옵션")!.props.hidden,
      false,
    );
  } finally {
    f.close();
  }
});

test("should open explicit fresh approval from a rejected command without issuing or confirming it", async () => {
  const f = fixture();
  try {
    await f.settle();
    await f.click("연결 명령 복사");
    const before = f.value(),
      saved = [...f.saved.entries()];
    const status = nodes(f.render()).find((n) => n.type === "setup-status")!;
    assert.equal(typeof status.props.onFreshApproval, "function");
    (status.props.onFreshApproval as () => void)();
    const tree = f.render();
    assert.equal(
      nodes(tree).find((n) => n.props["aria-label"] === "연결 추가 옵션")!.props.hidden,
      true,
    );
    assert.ok(nodes(tree).some((n) => n.props["aria-label"] === "새 승인 연결 확인"));
    assert.equal(nodes(tree).find((n) => n.props.type === "checkbox")!.props.checked, false);
    assert.equal(f.button("새 승인 명령 준비").props.disabled, true);
    assert.equal(f.value(), "");
    assert.deepEqual(f.copies, [before]);
    assert.deepEqual([...f.saved.entries()], saved);
    assert.equal(f.copies.length, 1);
  } finally {
    f.close();
  }
});

test("should block rejected credentials until explicit recovery and ignore stale failure reports", async () => {
  const f = fixture();
  try {
    await f.settle();
    await f.click("연결 명령 복사");
    const oldCopy = f.button("연결 명령 복사").props.onClick as () => Promise<void>;
    const status = nodes(f.render()).find((n) => n.type === "setup-status")!;
    const reject = status.props.onAuthenticationRejected as () => void;
    assert.equal(typeof reject, "function");
    reject();
    await f.settle();
    assert.equal(f.button("연결 명령 복사").props.disabled, true);
    assert.equal(f.value(), "");
    assert.equal(f.button("새 승인 명령 준비").props.disabled, true);
    assert.equal(nodes(f.render()).find((n) => n.props.type === "checkbox")!.props.checked, false);
    assert.ok(!text(f.render()).includes("명령을 복사했습니다."));
    await oldCopy();
    assert.equal(f.copies.length, 1);
    assert.equal(f.saved.size, 0);
    await f.click("취소");
    reject();
    await f.settle();
    assert.equal(f.button("연결 명령 복사").props.disabled, true);
    assert.ok(!nodes(f.render()).some((n) => n.props["aria-label"] === "새 승인 연결 확인"));
    await f.choose();
    await f.click("새 승인 명령 준비");
    await f.settle();
    reject();
    await f.settle();
    assert.equal(f.button("연결 명령 복사").props.disabled, false);
    assert.equal(f.saved.size, 1);
    await f.click("연결 명령 복사");
    assert.equal(f.copies.length, 2);
  } finally {
    f.close();
  }
});

test("should retain rejection after alias changes and discard an in-flight reissue", async () => {
  const f = fixture();
  try {
    await f.settle();
    await f.click("연결 명령 복사");
    const status = nodes(f.render()).find((n) => n.type === "setup-status")!;
    let release!: () => void;
    f.faults.issue = new Promise<void>((resolve) => {
      release = resolve;
    });
    (status.props.onRetry as () => void)();
    (status.props.onAuthenticationRejected as () => void)();
    release();
    await f.settle();
    assert.equal(f.copies.length, 1);
    await f.click("취소");
    const alias = nodes(f.render()).find((n) => n.type === "input" && n.props.maxLength === 40)!;
    (alias.props.onChange as (event: unknown) => void)({ target: { value: "Other name" } });
    await f.settle();
    assert.equal(f.button("연결 명령 복사").props.disabled, true);
    assert.equal(f.value(), "");
    assert.equal(f.saved.size, 0);
  } finally {
    f.close();
  }
});

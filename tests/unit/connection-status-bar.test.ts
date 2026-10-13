import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as presence from "../../src/features/device-binding/connection-presence.ts";
import * as contracts from "../../src/features/device-binding/contracts.ts";

type Node = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
function load(path: string, dependencies: Record<string, unknown>, globals = {}) {
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected status dependency ${name}`);
    },
    ...globals,
  });
  return exports;
}
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text((value as Node).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
const checkedAt = "2026-10-12T02:00:00.000Z";
const snapshot: presence.ConnectionSnapshot = {
  state: "connected",
  checkedAt,
  activeCount: 2,
  connectedCount: 1,
  devices: [
    {
      deviceAlias: "업무 Mac",
      roomTitle: "개발방",
      organizationName: "개발팀",
      state: "connected",
      reason: "최근 통신 확인",
      lastSeenAt: checkedAt,
    },
    {
      deviceAlias: "집 Mac",
      roomTitle: "기획방",
      organizationName: "기획팀",
      state: "unconfirmed",
      reason: "통신 기록 없음",
      lastSeenAt: null,
    },
  ],
};

test("should refresh only after an explicit status action and distinguish device states", (t) => {
  let refreshes = 0;
  const exports = load("src/features/device-binding/connection-status-bar.tsx", {
    "next/link": { default: "a" },
    "next/navigation": {
      useRouter: () => ({
        refresh: () => {
          refreshes++;
        },
      }),
    },
    react: { useTransition: () => [false, (action: () => void) => action()] },
    "./connection-presence": presence,
  });
  const render = exports.ConnectionStatusBar as (props: {
    snapshot: presence.ConnectionSnapshot;
  }) => Node;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse(checkedAt) });
  const initial = render({ snapshot });
  assert.equal(initial.props["aria-label"], "PC 연결 상태");
  assert.match(text(initial), /최근 통신 확인 1\/2대/);
  const list = nodes(initial).filter((node) => node.type === "li");
  const details = nodes(initial).find((node) => node.type === "details")!;
  assert.equal(details.props.open, undefined);
  const summary = nodes(details).find((node) => node.type === "summary")!;
  assert.match(summary.props["aria-label"] as string, /PC 연결 상태.*AI 응답 준비는 별도/);
  assert.match(text(summary), /PC 연결/);
  assert.match(text(summary), /AI 준비 별도/);
  assert.match(summary.props.className as string, /\bw-9\b/);
  assert.match(summary.props.className as string, /\bh-9\b/);
  const readinessHint = nodes(summary).find((node) => node.props.children === "AI 준비 별도")!;
  assert.match(readinessHint.props.className as string, /\bhidden\b/);
  assert.match(readinessHint.props.className as string, /\blg:block\b/);
  assert.match(text(details), /AI 응답 준비는 별도로 확인하세요/);
  assert.ok(
    nodes(summary).some(
      (node) => node.props.children === "PC" && node.props.className === "lg:hidden",
    ),
  );
  assert.ok(nodes(summary).some((node) => String(node.props.className).includes("bg-green-600")));
  assert.equal(nodes(details).filter((node) => node.type === "time").length, 2);
  assert.equal(nodes(initial).filter((node) => node.type === "button").length, 1);
  assert.equal(list.length, 2);
  assert.match(text(list[0]), /업무 Mac.*개발방.*연결 통신 확인/);
  assert.match(text(list[1]), /집 Mac.*기획방.*연결 확인 안 됨/);
  assert.equal(nodes(initial).filter((node) => node.type === "time").length, 2);
  assert.match(text(initial), /90초 미만/);
  assert.match(text(initial), /현재 AI 답변을 보장하지 않습니다/);
  t.mock.timers.tick(120_000);
  assert.match(text(render({ snapshot })), /최근 통신 확인 1\/2대/);
  assert.equal(refreshes, 0);
  const button = nodes(initial).find((node) => node.type === "button")!;
  (button.props.onClick as () => void)();
  assert.equal(refreshes, 1);
  const unavailable = render({ snapshot: presence.unavailableConnectionSnapshot(checkedAt) });
  assert.match(text(unavailable), /확인 불가/);
  assert.ok(!text(unavailable).includes("업무 Mac"));
  assert.equal(refreshes, 1);
});

test("should project only the owned connection snapshot and fail closed without changing the session", async () => {
  let calls = 0,
    authenticated = 0,
    cookies = true,
    fail = false,
    authFail = false;
  let sessionWrites = 0;
  const data = {
    devices: [
      {
        deviceId: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000002",
        roomId: "00000000-0000-4000-8000-000000000003",
        deviceAlias: "업무 Mac",
        state: "active",
        lastSeenAt: checkedAt,
        expiresAt: "2099-01-01T00:00:00Z",
        credential: "hidden-credential",
        root: "/hidden-root",
      },
    ],
    rooms: [
      {
        roomId: "00000000-0000-4000-8000-000000000003",
        organizationId: "00000000-0000-4000-8000-000000000002",
        roomTitle: "개발방",
        organizationName: "우리 팀",
      },
    ],
  };
  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      assert.equal(name, "connection_list");
      assert.deepEqual(Object.keys(params), []);
      calls++;
      return fail
        ? { data: null, error: { code: "P0001", message: "hidden-authentication-error" } }
        : { data, error: null };
    },
  };
  const service = load("src/features/device-binding/service.ts", {
    "server-only": {},
    "../room-access/team-entry-policy": { retryableAuthFailure: () => false },
    "./device-client": { deviceClient: () => assert.fail("must not create a device client") },
    "../../lib/supabase/server": {
      serverConfig: () => assert.fail("must not request server credentials"),
    },
    "./contracts": contracts,
  });
  const exports = load("src/features/device-binding/owned-connection-status.tsx", {
    "server-only": {},
    "../../lib/supabase/server": {
      requestClient: async () => ({
        client,
        hasAuthCookies: cookies,
        preserveSessionCookies: () => {
          sessionWrites++;
        },
        clearSessionCookies: () => {
          sessionWrites++;
        },
      }),
    },
    "../room-access/access-service": {
      currentUser: async (supplied: unknown) => {
        assert.equal(supplied, client);
        authenticated++;
        if (authFail) throw new Error("hidden-authentication-error");
      },
    },
    "./service": service,
    "./connection-presence": presence,
    "./connection-status-bar": { ConnectionStatusBar: "StatusBar" },
  });
  const render = exports.OwnedConnectionStatus as () => Promise<Node | null>;
  const result = await render();
  assert.equal(result?.type, "StatusBar");
  assert.equal(calls, 1);
  assert.equal(authenticated, 1);
  assert.ok(!JSON.stringify(result).includes("hidden-"));
  assert.ok(!JSON.stringify(result).includes("00000000"));
  fail = true;
  const failure = await render();
  assert.equal((failure?.props.snapshot as presence.ConnectionSnapshot).state, "unavailable");
  assert.ok(!JSON.stringify(failure).includes("hidden-"));
  authFail = true;
  assert.equal(
    ((await render())!.props.snapshot as presence.ConnectionSnapshot).state,
    "unavailable",
  );
  assert.equal(calls, 2);
  cookies = false;
  assert.equal(await render(), null);
  assert.equal(calls, 2);
  assert.equal(authenticated, 3);
  assert.equal(sessionWrites, 0);
});

test("should stream status independently while preserving the page node and available height", () => {
  const exports = load("src/app/app/layout.tsx", {
    react: { Suspense: "Suspense" },
    "../../features/device-binding/owned-connection-status": {
      OwnedConnectionStatus: "OwnedStatus",
    },
    "../../features/device-binding/connection-status-bar": { ConnectionStatusBar: "StatusBar" },
    "../../features/device-binding/connection-presence": presence,
    "../../features/room-access/chat-shell": { ConnectionNavigationProvider: "NavigationProvider" },
  });
  const render = exports.default as (props: { children: Node }) => Node;
  const page = jsx("main", { children: "draft-owning-page" });
  const result = render({ children: page });
  assert.equal(result.type, "NavigationProvider");
  assert.equal(result.props.children, page);
  const boundary = result.props.connection as Node;
  assert.equal(boundary.type, "Suspense");
  assert.ok(boundary.props.fallback);
  assert.equal(nodes(boundary).filter((node) => node.type === "OwnedStatus").length, 1);
  assert.equal(render({ children: page }).props.children, page);
});

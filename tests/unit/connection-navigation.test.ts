import { connectionSnapshot } from "../../src/features/device-binding/connection-presence.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as access from "../../src/features/room-access/contracts.ts";
import * as connections from "../../src/features/device-binding/contracts.ts";

type UINode = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
function load(path: string, dependencies: Record<string, unknown>) {
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
    Date,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected connection navigation dependency ${name}`);
    },
  });
  return exports;
}
function nodes(value: unknown): UINode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as UINode;
  return [node, ...nodes(node.props?.children)];
}
const writableId = "00000000-0000-4000-8000-000000000001";
const observerId = "00000000-0000-4000-8000-000000000002";
const organizationId = "00000000-0000-4000-8000-000000000003";
const navigationRooms: access.Room[] = [writableId, observerId].map((id) => ({
  id,
  organization_id: organizationId,
  title: id === writableId ? "참여방" : "관찰방",
  goal: "",
  observation: "",
  environment: "",
}));
const rooms = [{ roomId: writableId, organizationId, roomTitle: "참여방", organizationName: "팀" }];
function shellHarness() {
  const changes: boolean[] = [];
  const effects: (() => (() => void) | void)[] = [];
  const portals: { children: unknown; host: unknown }[] = [];
  let context: unknown = null;
  const components = load("src/features/room-access/chat-shell.tsx", {
    react: {
      createContext: (value: unknown) => ({ Provider: "provider", value }),
      useContext: () => context,
      useLayoutEffect(effect: () => (() => void) | void) {
        effects.push(effect);
      },
      useState: (initial: unknown) => [initial, (open: boolean) => changes.push(open)],
      useRef: (current: unknown) => ({ current }),
    },
    "react-dom": {
      createPortal: (children: unknown, host: unknown) => {
        portals.push({ children, host });
        return children;
      },
    },
    "next/link": { default: "link" },
    "lucide-react": Object.fromEntries(
      ["Menu", "Users", "MessageSquare", "Plus", "Plug"].map((name) => [name, "icon"]),
    ),
    "../../components/ui/button": { Button: "button" },
    "../../components/ui/scroll-area": { ScrollArea: "scroll" },
    "../../components/ui/sheet": Object.fromEntries(
      [
        "Sheet",
        "SheetContent",
        "SheetHeader",
        "SheetTitle",
        "SheetDescription",
        "SheetTrigger",
      ].map((name) => [name, name]),
    ),
  });
  const shell = components.ChatShell as (props: Record<string, unknown>) => UINode;
  return {
    shell,
    changes,
    components,
    portals,
    effects,
    setContext(value: unknown) {
      context = value;
    },
  };
}

test("should supply one connection slot and retain page content without a navigation host", () => {
  const h = shellHarness();
  const provider = h.components.ConnectionNavigationProvider as (props: unknown) => UINode;
  const page = jsx("main", { children: "unavailable page" });
  const slot = jsx("owned-status", {});
  const tree = provider({ children: page, connection: slot });
  assert.equal(nodes(tree).filter((node) => node.type === "owned-status").length, 1);
  assert.equal(nodes(tree).filter((node) => node === page).length, 1);
  const connection = nodes(tree).find((node) => node.props["aria-label"] === "내 AI 연결 확인")!;
  assert.equal(connection.props["data-placement"], "fallback");
  assert.match(String(connection.props.className), /top-2.5/);
  const registrations: boolean[] = [];
  h.setContext((mounted: boolean) => registrations.push(mounted));
  h.shell({ title: "채팅방", children: null });
  const cleanup = h.effects[0]();
  assert.deepEqual(registrations, [true]);
  cleanup?.();
  assert.deepEqual(registrations, [true, false]);
});

test("should use the same header portal host and provide an independent rendering fallback", () => {
  const h = shellHarness();
  const render = h.components.ChatHeaderControls as (props: unknown) => UINode | null;
  const controls = jsx("advanced-controls", {});
  const standalone = render({ children: controls });
  assert.equal(nodes(standalone).filter((node) => node === controls).length, 1);
  h.setContext({ host: null });
  assert.equal(render({ children: controls }), null);
  assert.equal(h.portals.length, 0);
  const host = {};
  h.setContext({ host });
  render({ children: controls });
  render({ children: jsx("advanced-controls", { snapshot: "next poll" }) });
  assert.equal(h.portals.length, 2);
  assert.ok(h.portals.every((portal) => portal.host === host));
});

test("should keep a single set of room actions in an accessible compact menu", () => {
  const actions = jsx("room-management", {});
  const tree = shellHarness().shell({
    title: "긴 채팅방 제목",
    children: null,
    actions,
    details: jsx("p", { children: "참가자" }),
  });
  const menu = nodes(tree).find(
    (node) => node.type === "button" && node.props["aria-label"] === "채팅방 기능 열기",
  );
  assert.ok(menu);
  assert.equal(menu.props["aria-expanded"], false);
  assert.equal(nodes(tree).filter((node) => node.type === "room-management").length, 1);
});
function manager(props: Record<string, unknown> = {}) {
  const component = load("src/features/device-binding/connection-manager.tsx", {
    react: {
      useEffect() {},
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [
        typeof initial === "function" ? initial() : initial,
        () => {},
      ],
    },
    "next/link": { default: "link" },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "./contracts": connections,
    "../../components/ui/button": { Button: "button" },
    "../../components/ui/input": { Input: "input" },
    "../room-access/chat-shell": { ChatShell: "shell" },
    "../runtime-settings/runtime-settings-form": { RuntimeSettingsForm: "settings-form" },
    "./local-connection-guide": { LocalConnectionGuide: "connection-guide" },
    "./local-connection-command": {},
    "./connection-presence": { connectionSnapshot },
    "../room-access/access.module.css": { default: {} },
  }).ConnectionManager as (props: unknown) => UINode;
  return component({
    devices: [],
    rooms,
    navigationRooms,
    origin: "https://example.test",
    userId: organizationId,
    ...props,
  });
}
function pageHarness(
  options: {
    navigationFailure?: unknown;
    connectionFailure?: unknown;
    identityFailure?: unknown;
    accessService?: Record<string, unknown>;
    client?: unknown;
  } = {},
) {
  const Page = load("src/app/app/connections/page.tsx", {
    "next/link": { default: "link" },
    "next/navigation": {
      redirect: (href: string) => {
        throw new Error(`REDIRECT:${href}`);
      },
    },
    "../../../lib/supabase/server": {
      requestClient: async () => ({ client: options.client ?? {} }),
      serverConfig: () => ({ origin: "https://example.test" }),
    },
    "../../../features/room-access/access-service": options.accessService ?? {
      currentUser: async () => {
        if (options.identityFailure) throw options.identityFailure;
        return organizationId;
      },
      accessibleRooms: async () => {
        if (options.navigationFailure) throw options.navigationFailure;
        return navigationRooms;
      },
    },
    "../../../features/room-access/contracts": access,
    "../../../features/room-access/chat-shell": { ChatShell: "shell" },
    "../../../features/device-binding/service": {
      ownedConnections: async () => {
        if (options.connectionFailure) throw options.connectionFailure;
        return { devices: [], rooms };
      },
    },
    "../../../features/device-binding/connection-manager": { ConnectionManager: "manager" },
    "../../../features/device-binding/contracts": connections,
  }).default as (props: unknown) => Promise<UINode>;
  return (room?: string | string[]) => Page({ searchParams: Promise.resolve({ room }) });
}

function roomServiceHarness(
  options: {
    roomsFail?: boolean;
    unauthenticated?: boolean;
    admissionFailure?: unknown;
    wrongAdmission?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const visibleRooms = [navigationRooms[1], navigationRooms[0]];
  const client = {
    auth: {
      getUser: async () => {
        calls.push("auth");
        return options.unauthenticated
          ? { data: { user: null }, error: { name: "AuthSessionMissingError", status: 401 } }
          : { data: { user: { id: organizationId } }, error: null };
      },
    },
    from(table: string) {
      calls.push(table);
      return {
        async select(columns: string) {
          if (table === "organizations")
            return { data: null, error: { message: "synthetic organization outage" } };
          assert.equal(table, "rooms");
          assert.equal(columns, "id,organization_id,title,goal,observation,environment");
          return options.roomsFail
            ? { data: null, error: { message: "synthetic room outage" } }
            : { data: visibleRooms, error: null };
        },
      };
    },
  };
  const policy = load("src/features/room-access/team-entry-policy.ts", { "./contracts": access });
  const service = load("src/features/room-access/access-service.ts", {
    "server-only": {},
    "./contracts": access,
    "./team-entry-policy": policy,
    "./team-entry-service": {
      admittedEntry: async (received: unknown) => {
        assert.equal(received, client);
        calls.push("admission");
        if (options.admissionFailure) throw options.admissionFailure;
        return {
          userId: options.wrongAdmission ? observerId : organizationId,
          displayName: "동료",
        };
      },
    },
  });
  return { client, service, calls, visibleRooms };
}

test("should keep valid connection setup when only organizations are unavailable through the actual room service", async () => {
  const fixture = roomServiceHarness();
  const root = await pageHarness({ accessService: fixture.service, client: fixture.client })(
    observerId,
  );
  assert.equal(root.type, "manager");
  assert.deepEqual(root.props.navigationRooms, fixture.visibleRooms);
  assert.equal(root.props.returnRoomId, observerId);
  assert.deepEqual(root.props.rooms, rooms);
  assert.deepEqual(fixture.calls, ["auth", "admission", "auth", "admission", "rooms"]);
});

test("should preserve room-only query results and fail closed on a genuine room query error", async () => {
  const fixture = roomServiceHarness();
  const accessibleRooms = fixture.service.accessibleRooms as (
    client: unknown,
  ) => Promise<access.Room[]>;
  assert.deepEqual(await accessibleRooms(fixture.client), fixture.visibleRooms);
  assert.deepEqual(fixture.calls, ["auth", "admission", "rooms"]);
  const failing = roomServiceHarness({ roomsFail: true });
  const failed = await pageHarness({ accessService: failing.service, client: failing.client })(
    observerId,
  );
  assert.equal(failed.type, "shell");
  assert.equal((failed.props.rooms as unknown[]).length, 0);
  assert.equal(
    nodes(failed.props.actions).find((node) => node.type === "link")!.props.href,
    "/app",
  );
});

test("should keep room-only reads behind the actual authentication and admission checks", async () => {
  for (const options of [
    { unauthenticated: true },
    { admissionFailure: new access.AccessError("UNAUTHENTICATED") },
    { wrongAdmission: true },
  ]) {
    const fixture = roomServiceHarness(options);
    const accessibleRooms = fixture.service.accessibleRooms as (
      client: unknown,
    ) => Promise<access.Room[]>;
    await assert.rejects(() => accessibleRooms(fixture.client), { code: "UNAUTHENTICATED" });
    assert.equal(fixture.calls.includes("rooms"), false);
    await assert.rejects(
      pageHarness({ accessService: fixture.service, client: fixture.client })(observerId),
      /REDIRECT:\/login/,
    );
  }
  const denied = roomServiceHarness({ admissionFailure: new access.AccessError("FORBIDDEN") });
  const failed = await pageHarness({ accessService: denied.service, client: denied.client })(
    observerId,
  );
  assert.equal(failed.type, "shell");
  assert.equal(denied.calls.includes("rooms"), false);
});

test("should keep one ChatShell with all accessible rooms and an explicit authorized return link", () => {
  const root = manager({ returnRoomId: observerId });
  assert.equal(root.type, "shell");
  assert.equal(root.props.title, "내 AI 연결");
  assert.deepEqual(root.props.rooms, navigationRooms);
  const returnLink = nodes(root.props.actions).find((node) => node.type === "link")!;
  assert.equal(returnLink.props.href, `/app/rooms/${observerId}`);
  const tree = shellHarness().shell(root.props);
  assert.equal(nodes(tree).filter((node) => node.type === "main").length, 1);
  assert.equal(nodes(tree).filter((node) => node.type === "header").length, 1);
  const content = nodes(tree).find((node) => node.props["aria-label"] === "AI 연결 설정 내용")!;
  assert.match(String(content.props.className), /overflow-y-auto/);
  const sidebar = nodes(tree).find((node) => node.props["aria-label"] === "채팅방 탐색")!;
  assert.deepEqual(
    nodes(sidebar)
      .filter((node) => node.type === "link" && String(node.props.href).startsWith("/app/rooms/"))
      .map((node) => node.props.href),
    navigationRooms.map((room) => `/app/rooms/${room.id}`),
  );
});

test("should carry the current public room from chat and mark only connections as the active page", () => {
  const { shell, changes } = shellHarness();
  const chat = shell({
    rooms: navigationRooms,
    roomId: observerId,
    title: "관찰방",
    children: null,
  });
  const chatLinks = nodes(chat).filter(
    (node) => node.type === "link" && String(node.props.href).startsWith("/app/connections"),
  );
  assert.equal(chatLinks.length, 2);
  chatLinks.forEach((node) => assert.equal(node.props.href, `/app/connections?room=${observerId}`));
  const setup = shell(manager({ returnRoomId: observerId }).props);
  const links = nodes(setup).filter((node) => node.type === "link");
  assert.equal(links.filter((node) => node.props["aria-current"] === "page").length, 2);
  links
    .filter((node) => node.props["aria-current"] === "page")
    .forEach((node) => assert.ok(String(node.props.href).startsWith("/app/connections")));
  const mobile = nodes(setup).find((node) => node.type === "SheetContent")!;
  const navigation = nodes(mobile).find((node) => typeof node.props.onClick === "function")!;
  (navigation.props.onClick as (event: unknown) => void)({ target: { closest: () => ({}) } });
  assert.deepEqual(changes, [false]);
  let prevented = false;
  (mobile.props.onCloseAutoFocus as (event: unknown) => void)({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
});

test("should initialize setup only from a writable return room and keep observer navigation read-only", () => {
  for (const returnRoomId of [writableId, observerId]) {
    const root = manager({ returnRoomId });
    const guide = nodes(root).find((node) => node.type === "connection-guide")!;
    assert.equal(guide.props.roomId, writableId);
    for (const select of nodes(root).filter((node) => node.type === "select")) {
      assert.equal(select.props.value, writableId);
      assert.deepEqual(
        nodes(select)
          .filter((node) => node.type === "option")
          .map((node) => node.props.value),
        [writableId],
      );
    }
  }
  const observer = manager({ rooms: [], returnRoomId: observerId });
  assert.equal(
    nodes(observer).some((node) => node.type === "form" || node.type === "settings-form"),
    false,
  );
  assert.equal(
    nodes(observer.props.actions).find((node) => node.type === "link")!.props.href,
    `/app/rooms/${observerId}`,
  );
  const secondId = "00000000-0000-4000-8000-000000000004";
  const secondRoom = { ...navigationRooms[0], id: secondId };
  const selected = manager({
    returnRoomId: secondId,
    navigationRooms: [...navigationRooms, secondRoom],
    rooms: [...rooms, { ...rooms[0], roomId: secondId }],
  });
  assert.equal(
    nodes(selected).find((node) => node.type === "connection-guide")!.props.roomId,
    secondId,
  );
  nodes(selected)
    .filter((node) => node.type === "select")
    .forEach((node) => assert.equal(node.props.value, secondId));
});

test("should validate a single room query against accessible rooms independently of writable choices", async () => {
  const page = pageHarness();
  for (const room of [writableId, observerId]) {
    const root = await page(room);
    assert.equal(root.type, "manager");
    assert.equal(root.props.returnRoomId, room);
    assert.deepEqual(root.props.navigationRooms, navigationRooms);
    assert.deepEqual(root.props.rooms, rooms);
  }
  for (const query of [
    undefined,
    "https://example.test/elsewhere",
    "//example.test",
    "not-a-room-id",
    "",
    "00000000-0000-4000-8000-000000000099",
    [observerId],
    [writableId, observerId],
  ]) {
    const root = await page(query);
    assert.equal(root.props.returnRoomId, undefined);
  }
});

test("should retain authorized navigation when connection loading fails and close setup on navigation failure", async () => {
  const domainError = await pageHarness({
    connectionFailure: new connections.ConnectionError("UNAVAILABLE"),
  })(observerId);
  assert.equal(domainError.type, "shell");
  assert.deepEqual(domainError.props.rooms, navigationRooms);
  assert.equal(
    nodes(domainError).some((node) => node.props.role === "alert"),
    true,
  );
  assert.equal(
    nodes(domainError.props.actions).find((node) => node.type === "link")!.props.href,
    `/app/rooms/${observerId}`,
  );
  const denied = await pageHarness({ navigationFailure: new access.AccessError("FORBIDDEN") })(
    observerId,
  );
  assert.equal(denied.type, "shell");
  assert.equal((denied.props.rooms as unknown[]).length, 0);
  assert.equal(
    nodes(denied.props.actions).find((node) => node.type === "link")!.props.href,
    "/app",
  );
  for (const options of [
    { identityFailure: new access.AccessError("UNAUTHENTICATED") },
    { navigationFailure: new access.AccessError("UNAUTHENTICATED") },
    { connectionFailure: new connections.ConnectionError("UNAUTHENTICATED") },
  ])
    await assert.rejects(pageHarness(options)(observerId), /REDIRECT:\/login/);
});

test("should fall back to the app list when no accessible return room exists", () => {
  for (const returnRoomId of [
    undefined,
    "00000000-0000-4000-8000-000000000099",
    "https://example.test",
  ]) {
    const root = manager({ returnRoomId });
    assert.equal(
      nodes(root.props.actions).find((node) => node.type === "link")!.props.href,
      "/app",
    );
  }
});

test("should put executable Mac connection before unavailable AI controls for a new owner", () => {
  const tree = manager();
  const guide = nodes(tree).find((node) => node.type === "connection-guide")!;
  assert.equal(guide.props.prominent, true);
  assert.equal(guide.props.showRoomSelection, false);
  assert.equal(nodes(tree).filter((node) => node.type === "settings-form").length, 0);
  const command = nodes(tree).find((node) => node.props.id === "mac-connection")!;
  assert.equal(command.props.open, true);
  const settings = nodes(tree).find((node) => node.props.id === "ai-settings")!;
  assert.ok(nodes(tree).indexOf(command) < nodes(tree).indexOf(settings));
  assert.equal(
    nodes(tree).find((node) => node.props["aria-label"] === "기기 승인 안내")!.props.open,
    false,
  );
  const refresh = nodes(tree).find((node) => node.props["aria-label"] === "연결 상태 새로 확인")!;
  assert.equal(refresh.props.disabled, undefined);
  (refresh.props.onClick as () => void)();
  assert.equal(
    nodes(tree).find((node) => node.props["aria-label"] === "모델 선택과 채팅 시작"),
    undefined,
  );
});

test("should hide removed records by default and require explicit selection among multiple devices", () => {
  const device = (deviceId: string, state: string) => ({
    deviceId,
    deviceAlias: "검사 Mac",
    roomId: writableId,
    organizationId,
    state,
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const tree = manager({
    devices: [
      device(organizationId, "removed"),
      device(writableId, "active"),
      device(observerId, "active"),
    ],
  });
  assert.equal(nodes(tree).filter((node) => node.type === "settings-form").length, 0);
  assert.equal(
    nodes(tree).filter(
      (node) => node.type === "select" && node.props["aria-label"] === "설정할 본인 기기",
    )[0].props.value,
    "",
  );
  assert.equal(
    nodes(tree).some(
      (node) =>
        node.type === "summary" &&
        (node.props.children === "이전 연결 기록" || node.props.children === "연결 기록 확인"),
    ),
    false,
  );
  assert.ok(
    nodes(tree).some((node) => node.type === "button" && node.props.children === "연결 기록 확인"),
  );
});

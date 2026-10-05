import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/room-access/contracts.ts";

type UINode = { type: unknown; props: Record<string, unknown> };
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
      throw new Error(`Unexpected entry UI dependency ${name}`);
    },
    ...globals,
  });
  return exports;
}
function nodes(node: unknown): UINode[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as UINode;
  return [element, ...nodes(element.props?.children)];
}
function formHarness() {
  const states: unknown[] = [],
    refs: { current: unknown }[] = [];
  let stateIndex = 0,
    refIndex = 0;
  let effects: (() => void)[] = [];
  let focused = false;
  const calls: { path: string; body: Record<string, string> }[] = [];
  const destinations: string[] = [];
  let refreshes = 0;
  let respond: (result: unknown) => void = () => {};
  let reject: () => void = () => {};
  class Input {
    constructor(public value: string) {}
  }
  const code = new Input("fixture-company-code"),
    name = new Input("테스트 사용자");
  const react = {
    useState(initial: unknown) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [
        states[index],
        (value: unknown) => {
          states[index] = value;
        },
      ];
    },
    useRef(current: unknown) {
      const index = refIndex++;
      return refs[index] ?? (refs[index] = { current });
    },
    useEffect(effect: () => void) {
      effects.push(effect);
    },
  };
  const router = {
    useRouter: () => ({
      replace: (path: string) => destinations.push(path),
      refresh: () => refreshes++,
    }),
  };
  const actions = load(
    "src/features/room-access/client-actions.tsx",
    {
      react,
      "next/navigation": router,
      "./contracts": contracts,
      "../../components/ui/button": { Button: "button" },
      "../../components/ui/input": { Input: "input" },
      "./access.module.css": { default: {} },
    },
    {
      fetch: (path: string, options: { body: string }) => {
        calls.push({ path, body: JSON.parse(options.body) });
        return new Promise((resolve, fail) => {
          respond = (result) => resolve({ json: async () => result });
          reject = () => fail(new Error("synthetic network failure"));
        });
      },
      FormData: class {
        entries() {
          return [
            ["code", code.value],
            ["displayName", name.value],
          ];
        }
      },
    },
  );
  const component = load(
    "src/features/room-access/login-form.tsx",
    {
      "next/navigation": router,
      "next/link": { default: "link" },
      "./client-actions": actions,
      "./access.module.css": { default: {} },
      "../../components/ui/button": { Button: "button" },
      "../../components/ui/input": { Input: "input" },
    },
    { HTMLInputElement: Input },
  ).LoginForm as (props: { destination: string }) => UINode;
  function render() {
    stateIndex = 0;
    refIndex = 0;
    effects = [];
    const tree = component({ destination: `/app?invite=${"a".repeat(64)}` });
    for (const node of nodes(tree))
      if (node.props.role === "alert") {
        (node.props.ref as { current: unknown }).current = {
          focus() {
            focused = true;
          },
        };
      }
    effects.forEach((effect) => effect());
    return tree;
  }
  return {
    render,
    code,
    name,
    calls,
    destinations,
    respond: (result: unknown) => respond(result),
    reject: () => reject(),
    focused: () => focused,
    refreshes: () => refreshes,
    submit() {
      const form = nodes(render()).find((n) => n.type === "form")!;
      return (form.props.onSubmit as (event: unknown) => Promise<void>)({
        preventDefault() {},
        currentTarget: { elements: { namedItem: () => code } },
      });
    },
  };
}

test("should clear the code before awaiting admission and retain the exact submitted body", async () => {
  const h = formHarness();
  const inputs = nodes(h.render()).filter((n) => n.type === "input");
  assert.equal(inputs[0].props.type, "password");
  assert.equal(inputs[0].props.autoComplete, "off");
  assert.equal(inputs[0].props.maxLength, 128);
  assert.equal(inputs[1].props.maxLength, 80);
  const request = h.submit();
  assert.equal(h.code.value, "");
  assert.equal(h.name.value, "테스트 사용자");
  assert.deepEqual(h.calls, [
    {
      path: "/api/auth/enter",
      body: { code: "fixture-company-code", displayName: "테스트 사용자" },
    },
  ]);
  assert.equal(nodes(h.render()).find((n) => n.type === "button")?.props.disabled, true);
  h.respond({ ok: true, data: { userId: "fixture-id" } });
  await request;
  assert.deepEqual(h.destinations, [`/app?invite=${"a".repeat(64)}`]);
  assert.equal(h.refreshes(), 1);
});
for (const error of ["CODE_REJECTED", "CODE_COOLDOWN", "UNAVAILABLE"] as const) {
  test(`should clear a ${error} submission and focus its fixed error without losing the name`, async () => {
    const h = formHarness();
    const request = h.submit();
    h.respond({ ok: false, error: { code: error, privateDetail: "must not render" } });
    await request;
    const alert = nodes(h.render()).find((n) => n.props.role === "alert");
    assert.equal(alert?.props.children, contracts.messages[error]);
    assert.equal(h.focused(), true);
    assert.equal(h.code.value, "");
    assert.equal(h.name.value, "테스트 사용자");
    assert.deepEqual(h.destinations, []);
    assert.equal(nodes(h.render()).find((n) => n.type === "button")?.props.disabled, false);
  });
}
test("should retain a cleared code and focus unavailable after a network rejection", async () => {
  const h = formHarness();
  const request = h.submit();
  h.reject();
  await request;
  assert.equal(
    nodes(h.render()).find((n) => n.props.role === "alert")?.props.children,
    contracts.messages.UNAVAILABLE,
  );
  assert.equal(h.focused(), true);
  assert.equal(h.code.value, "");
  assert.deepEqual(h.destinations, []);
});

function resetAction(tree: UINode) {
  return nodes(tree).find(
    (node) => node.type === "button" && node.props.children === "로그아웃하고 새 입장 준비",
  );
}

test("should preserve a rejected identity until explicit logout and never automatically enter a new user", async () => {
  const h = formHarness();
  const request = h.submit();
  h.respond({ ok: false, error: { code: "UNAUTHENTICATED" } });
  await request;
  const tree = h.render();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.destinations, []);
  assert.equal(h.refreshes(), 0);
  const reset = resetAction(tree);
  assert.ok(reset, "Confirmed identity rejection must offer deliberate logout");
  assert.equal(reset.props.type, "button");
  assert.equal(
    nodes(tree).some(
      (node) =>
        typeof node.props.children === "string" &&
        node.props.children.includes(
          "이전 사용자와 AI 소유권은 같은 표시 이름으로 복구할 수 없습니다.",
        ),
    ),
    true,
  );
  const logout = (reset.props.onClick as () => Promise<void>)();
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ["/api/auth/enter", "/api/auth/logout"],
  );
  assert.deepEqual(h.calls[1].body, {});
  h.respond({ ok: true, data: { loggedOut: true } });
  await logout;
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(h.destinations, []);
  assert.equal(h.calls.length, 2);
  assert.equal(h.code.value, "");
  assert.equal(h.name.value, "테스트 사용자");
});

test("should retain identity on unavailable admission and retry without offering logout", async () => {
  const h = formHarness();
  const request = h.submit();
  h.respond({ ok: false, error: { code: "UNAVAILABLE" } });
  await request;
  assert.equal(resetAction(h.render()), undefined);
  assert.equal(h.calls.length, 1);
  assert.equal(h.refreshes(), 0);
  h.code.value = "retry-company-code";
  const retry = h.submit();
  h.respond({ ok: true, data: { userId: "same-fixture-id" } });
  await retry;
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ["/api/auth/enter", "/api/auth/enter"],
  );
  assert.equal(h.calls[1].body.displayName, "테스트 사용자");
  assert.deepEqual(h.destinations, [`/app?invite=${"a".repeat(64)}`]);
});

test("should leave failed explicit logout on login without entering another identity", async () => {
  const h = formHarness();
  const request = h.submit();
  h.respond({ ok: false, error: { code: "UNAUTHENTICATED" } });
  await request;
  const reset = resetAction(h.render());
  assert.ok(reset, "Confirmed identity rejection must offer deliberate logout");
  const logout = (reset.props.onClick as () => Promise<void>)();
  h.respond({ ok: false, error: { code: "UNAVAILABLE" } });
  await logout;
  assert.equal(h.refreshes(), 0);
  assert.deepEqual(h.destinations, []);
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ["/api/auth/enter", "/api/auth/logout"],
  );
});

test("should not offer identity reset for an unknown error or a network failure", async () => {
  for (const network of [false, true]) {
    const h = formHarness();
    const request = h.submit();
    if (network) h.reject();
    else h.respond({ ok: false, error: { code: "UNKNOWN_PROVIDER_FAILURE" } });
    await request;
    assert.equal(resetAction(h.render()), undefined);
    assert.equal(h.calls.length, 1);
    assert.equal(h.refreshes(), 0);
    assert.deepEqual(h.destinations, []);
  }
});

function pageHarness(serviceFailure?: unknown) {
  const client = { marker: "request-client" };
  let reads = 0;
  const redirects: string[] = [];
  const redirected = new Error("redirect");
  const page = load("src/app/login/page.tsx", {
    "next/navigation": {
      redirect(path: string) {
        redirects.push(path);
        throw redirected;
      },
    },
    "../../features/room-access/login-form": { LoginForm: "login" },
    "../../features/room-access/access-service": {
      async currentUser(value: unknown) {
        assert.equal(value, client);
        reads++;
        if (serviceFailure) throw serviceFailure;
        return "fixture-user";
      },
    },
    "../../features/room-access/contracts": contracts,
    "../../lib/supabase/server": {
      async requestClient() {
        return { client };
      },
    },
  }).default as (props: {
    searchParams: Promise<{ invite?: string | string[] }>;
  }) => Promise<UINode>;
  return {
    page: (invite?: string | string[]) => page({ searchParams: Promise.resolve({ invite }) }),
    redirects,
    redirected,
    reads: () => reads,
  };
}
test("should reconnect an admitted identity to its validated invitation without another form", async () => {
  const h = pageHarness();
  await assert.rejects(h.page("b".repeat(64)), (error) => error === h.redirected);
  assert.deepEqual(h.redirects, [`/app?invite=${"b".repeat(64)}`]);
  assert.equal(h.reads(), 1);
});
test("should preserve only a single valid invitation for an unauthenticated entry", async () => {
  for (const invite of [
    "c".repeat(64),
    "bad",
    "/outside",
    ["d".repeat(64)],
    "D".repeat(64),
    undefined,
  ]) {
    const h = pageHarness(new contracts.AccessError("UNAUTHENTICATED"));
    const result = await h.page(invite);
    assert.equal(result.type, "login");
    assert.equal(
      result.props.destination,
      invite === "c".repeat(64) ? `/app?invite=${invite}` : "/app",
    );
    assert.deepEqual(h.redirects, []);
  }
});
test("should reconnect to the dashboard when an invitation is malformed or repeated", async () => {
  for (const invite of ["bad", ["a".repeat(64)], undefined]) {
    const h = pageHarness();
    await assert.rejects(h.page(invite), (error) => error === h.redirected);
    assert.deepEqual(h.redirects, ["/app"]);
  }
});
test("should render unavailable for classified service failures rather than offering entry", async () => {
  for (const failure of [
    new contracts.AccessError("UNAVAILABLE"),
    new contracts.AccessError("FORBIDDEN"),
    new Error("synthetic internal failure"),
  ]) {
    const h = pageHarness(failure);
    const tree = await h.page();
    assert.equal(
      nodes(tree).some((n) => n.type === "login"),
      false,
    );
    assert.equal(
      nodes(tree).find((n) => n.props.role === "alert")?.props.children,
      contracts.messages.UNAVAILABLE,
    );
    assert.deepEqual(h.redirects, []);
    assert.equal(h.reads(), 1);
  }
});

test("should create a room using the admitted display name and internal defaults", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const paths: string[] = [];
  const defaults = load("src/features/room-access/room-defaults.ts", {});
  const dashboard = load("src/features/room-access/access-dashboard.tsx", {
    react: {
      useEffect() {},
      useRef: () => ({ current: null }),
      useState: (v: unknown) => [v, () => {}],
    },
    "next/link": { default: "link" },
    "next/navigation": {
      useRouter: () => ({ push: (path: string) => paths.push(path), refresh() {} }),
    },
    "lucide-react": { MessageSquare: "icon", Plus: "icon" },
    "./client-actions": {
      LogoutButton: "logout",
      formValues: (value: unknown) => value,
      useMutation: () => ({
        busy: false,
        errorNode: null,
        async send(path: string, body: unknown) {
          calls.push({ path, body });
          return { roomId: "created-room" };
        },
      }),
    },
    "./room-defaults": defaults,
    "./chat-shell": { ChatShell: "shell" },
    "../../components/ui/button": { Button: "button" },
    "../../components/ui/input": { Input: "input" },
    "../../components/ui/dialog": Object.fromEntries(
      [
        "Dialog",
        "DialogContent",
        "DialogHeader",
        "DialogTitle",
        "DialogDescription",
        "DialogTrigger",
      ].map((name) => [name, name]),
    ),
  }).AccessDashboard as (props: unknown) => UINode;
  const tree = dashboard({
    userId: "user",
    organizations: [],
    rooms: [],
    displayName: "입장한 이름",
  });
  const form = nodes(tree).find(
    (node) =>
      node.type === "form" &&
      nodes(node).some((child) => child.type === "input" && child.props.name === "title"),
  )!;
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({
    preventDefault() {},
    currentTarget: { title: "방 제목" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      path: "/api/access/bootstrap",
      body: {
        title: "방 제목",
        goal: "참가자 간 AI 채팅",
        observation: "입력하지 않음",
        environment: "입력하지 않음",
        groupName: "내 AI 채팅방",
        displayAlias: "입장한 이름",
      },
    },
  ]);
  assert.deepEqual(paths, ["/app/rooms/created-room"]);
  assert.equal(
    nodes(tree).some((node) => node.type === "input" && node.props.name === "displayAlias"),
    false,
  );
});

test("should load an empty login first and replace every stale Auth chunk before adopting the owned session", async () => {
  const cookies = new Map([
    ["sb-local-auth-token.0", "old"],
    ["sb-local-auth-token.7", "old"],
    ["sb-local-auth-token-code-verifier.0", "old"],
    ["preference", "keep"],
  ]);
  const stages: string[] = [];
  const context = {
    async clearCookies({ name }: { name: RegExp }) {
      stages.push("clear");
      for (const key of cookies.keys()) if (name.test(key)) cookies.delete(key);
    },
    async addCookies(incoming: { name: string; value: string }[]) {
      stages.push("adopt");
      for (const cookie of incoming) cookies.set(cookie.name, cookie.value);
    },
  };
  const page = {
    context: () => context,
    async goto(path: string) {
      assert.equal(path, "/login");
      assert.deepEqual([...cookies.keys()], ["preference"]);
      stages.push("empty-login");
    },
    getByLabel: () => ({}),
  };
  const helper = load("tests/helpers/browser-team-entry.ts", {
    "@playwright/test": {
      expect: () => ({
        async toBeVisible() {
          stages.push("form-visible");
        },
      }),
    },
  });
  const prepare = helper.prepareTeamEntry as (
    page: unknown,
    load: () => Promise<unknown>,
  ) => Promise<unknown>;
  const entry = {
    code: "fixture-code",
    cookies: [{ name: "sb-local-auth-token.0", value: "owned", url: "http://localhost" }],
  };
  assert.equal(
    await prepare(page, async () => {
      stages.push("fixture");
      return entry;
    }),
    entry,
  );
  assert.deepEqual(stages, ["clear", "empty-login", "form-visible", "fixture", "clear", "adopt"]);
  assert.deepEqual(
    [...cookies],
    [
      ["preference", "keep"],
      ["sb-local-auth-token.0", "owned"],
    ],
  );
});

test("should reject a browser entry response with a different actor using only a fixed safe failure", async () => {
  const steps: string[] = [];
  const page = {
    getByLabel: () => ({ async fill() {} }),
    getByRole: () => ({
      async click() {
        steps.push("submit");
      },
    }),
    waitForResponse() {
      steps.push("wait");
      return Promise.resolve({
        status: () => 200,
        json: async () => ({
          ok: true,
          data: { userId: "private-other-actor", displayName: "same name" },
        }),
      });
    },
  };
  const helper = load("tests/helpers/browser-team-entry.ts", {
    "@playwright/test": { expect: () => ({ async toBeVisible() {} }) },
  });
  const submit = helper.submitTeamEntry as (
    page: unknown,
    person: unknown,
    entry: unknown,
  ) => Promise<void>;
  await assert.rejects(
    submit(page, { id: "fixture-actor", displayName: "same name" }, { code: "fixture-code" }),
    (error: unknown) => {
      assert.equal((error as Error).message, "Owned team entry assertion failed");
      return true;
    },
  );
  assert.deepEqual(steps, ["wait", "submit"]);
});

for (const invited of [false, true]) {
  test(`should verify admitted navigation in the ${invited ? "automatic invitation dialog" : "accessible dashboard"}`, async () => {
    const token = "a".repeat(64);
    const checked: string[] = [];
    const page = {
      url: () => `http://localhost/app${invited ? `?invite=${token}` : ""}`,
      getByLabel: () => ({ async fill() {} }),
      getByRole(role: string, options: { name: string }) {
        if (role === "button") return { async click() {} };
        if (role === "heading") {
          assert.equal(invited, false, "Invitation dialog hides the surrounding heading");
          return "dashboard";
        }
        assert.equal(role, "dialog");
        assert.equal(options.name, "초대로 참가");
        return {
          marker: "invitation",
          getByLabel() {
            return {
              async inputValue() {
                return token;
              },
            };
          },
        };
      },
      waitForResponse: async () => ({
        status: () => 200,
        json: async () => ({
          ok: true,
          data: { userId: "owned-actor", displayName: "admitted-name" },
        }),
      }),
    };
    const helper = load(
      "tests/helpers/browser-team-entry.ts",
      {
        "@playwright/test": {
          expect(value: unknown) {
            return {
              async toHaveURL(predicate: (url: URL) => boolean) {
                assert.equal(value, page);
                assert.equal(predicate(new URL(page.url())), true);
                checked.push("app");
              },
              async toBeVisible() {
                checked.push(
                  typeof value === "string" ? value : (value as { marker: string }).marker,
                );
              },
            };
          },
        },
      },
      { URL },
    );
    const submit = helper.submitTeamEntry as (
      page: unknown,
      person: unknown,
      entry: unknown,
    ) => Promise<void>;
    await submit(
      page,
      { id: "owned-actor", displayName: "admitted-name" },
      { code: "fixture-code" },
    );
    assert.deepEqual(checked, ["app", invited ? "invitation" : "dashboard"]);
  });
}

test("should defer mobile room creation until the Sheet closes and retain its visible focus target", () => {
  const changes: boolean[] = [];
  const returns: unknown[] = [];
  const shell = load("src/features/room-access/chat-shell.tsx", {
    react: {
      useState: () => [true, (open: boolean) => changes.push(open)],
      useRef: (current: unknown) => ({ current }),
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
  }).ChatShell as (props: unknown) => UINode;
  const trigger = jsx("DialogTrigger", {});
  const tree = shell({
    title: "dashboard",
    children: null,
    newRoom: trigger,
    onNewRoom: (target: unknown) => returns.push(target),
  });
  const content = nodes(tree).find((node) => node.type === "SheetContent")!;
  assert.equal(
    nodes(content).some((node) => node.type === "DialogTrigger"),
    false,
  );
  const menu = nodes(tree).find((node) => node.props["aria-label"] === "채팅방 목록 열기")!;
  const focusTarget = { focus() {} };
  (menu.props.ref as { current: unknown }).current = focusTarget;
  const create = nodes(content).find((node) => node.type === "button")!;
  (create.props.onClick as () => void)();
  assert.deepEqual(changes, [false]);
  assert.deepEqual(returns, []);
  let prevented = 0;
  const closed = content.props.onCloseAutoFocus as (event: unknown) => void;
  closed({
    preventDefault() {
      prevented++;
    },
  });
  assert.deepEqual(returns, [focusTarget]);
  assert.equal(prevented, 1);
  closed({
    preventDefault() {
      prevented++;
    },
  });
  assert.equal(returns.length, 1);
  assert.equal(prevented, 1);
});

import { test, expect, type Browser, type TestInfo, type Page } from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);
import { enterTeam, type BrowserEntry, type BrowserPerson } from "../helpers/browser-team-entry.js";
async function revealRoomActions(page: Page) {
  const summary = page.getByLabel("채팅방 기능 열기", { exact: true });
  if (await summary.isVisible()) {
    if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
  }
}
function check(value: unknown): asserts value {
  if (!value) throw new Error("Owned device browser assertion failed");
}
async function broker<T>(action: string, body: unknown): Promise<T> {
  const endpoint = process.env.LOCAL_DEVICE_FIXTURE_URL,
    token = process.env.LOCAL_DEVICE_FIXTURE_TOKEN;
  check(endpoint && token && new URL(endpoint).hostname === "127.0.0.1");
  const response = await fetch(`${endpoint}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  check(response.ok);
  return response.json() as Promise<T>;
}
async function context(browser: Browser, info: TestInfo) {
  return browser.newContext({
    baseURL: process.env.APP_ORIGIN,
    viewport: info.project.use.viewport,
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
  });
}
async function login(page: Page, displayName: string) {
  const person = await broker<BrowserPerson>("person", {});
  await enterTeam(page, person, () => broker<BrowserEntry>("code", { id: person.id }), displayName);
  return person;
}

async function createRoom(page: Page) {
  await page.getByRole("button", { name: "새 채팅방", exact: true }).click();
  const section = page.getByRole("dialog", { name: "새 채팅방", exact: true });
  await section.getByLabel("방 이름", { exact: true }).fill("기기 검사방");
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/access/bootstrap"),
  );
  await section.getByRole("button", { name: "방 만들기", exact: true }).click();
  const result = await (await response).json();
  check(result.ok);
  await broker("track", { organizationId: result.data.organizationId });
  await expect(page.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
  return result.data as { roomId: string; organizationId: string };
}
async function join(owner: Page, member: Page, role: string) {
  await revealRoomActions(owner);
  await owner.getByRole("button", { name: "채팅방 관리", exact: true }).click();
  await owner.getByRole("combobox", { name: "초대 역할", exact: true }).selectOption(role);
  await owner.getByRole("button", { name: "초대 발급", exact: true }).click();
  const output = owner.getByLabel("발급된 초대 코드", { exact: true });
  await expect(output).toBeVisible();
  const code = await output.textContent();
  check(code);
  await member.goto("/app");
  await member.getByRole("button", { name: "초대로 참가", exact: true }).click();
  await member.getByLabel("초대 코드", { exact: true }).fill(code);
  await member.getByRole("button", { name: "방 참가", exact: true }).click();
  await expect(member.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "코드 숨기기", exact: true }).click();
  await owner.keyboard.press("Escape");
}
async function roomNavigation(page: Page) {
  const menu = page.getByRole("button", { name: "채팅방 목록 열기", exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    return page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true });
  }
  return page.getByRole("complementary", { name: "채팅방 탐색", exact: true });
}
async function connectionsFromRoom(page: Page, roomId: string) {
  await page.goto(`/app/rooms/${roomId}`);
  const navigation = await roomNavigation(page);
  const connection = navigation.getByRole("link", { name: /내 AI 연결/ });
  await expect(connection).toHaveAttribute("href", `/app/connections?room=${roomId}`);
  await connection.click();
  await expect(page).toHaveURL(new RegExp(`/app/connections\\?room=${roomId}$`));
  await expect(
    page.getByRole("heading", { name: "내 AI 연결", level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true })).toHaveCount(0);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.locator("main > section > header")).toHaveCount(1);
  const connectionsNavigation = await roomNavigation(page);
  await expect(
    connectionsNavigation.getByRole("link", { name: "기기 검사방", exact: true }),
  ).toHaveAttribute("href", `/app/rooms/${roomId}`);
  await expect(connectionsNavigation.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(connectionsNavigation.getByRole("link", { name: /내 AI 연결/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  if (await page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true }).isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "채팅방 목록 열기", exact: true })).toBeFocused();
  }
}
async function connect(page: Page, id: string, name: string, roomId: string) {
  const p = await broker<{ name: string; code: string }>("pair", { id, name });
  await connectionsFromRoom(page, roomId);
  await page.getByRole("combobox", { name: "연결할 방", exact: true }).selectOption(roomId);
  await page.getByLabel("기기 연결 코드", { exact: true }).fill(p.code);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "기기 승인", exact: true }).click();
  await expect(page.getByRole("status", { name: "기기 연결 결과" })).toContainText("승인을 완료");
  await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue("");
  await broker("register", { id, name });
  const device = page
    .locator("main li")
    .filter({ has: page.getByText(`기기 ${name}`, { exact: true }) });
  await expect(device.getByText("등록 · 실행 미검증", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("combobox", { name: "AI 프로그램", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "이전 채팅방으로", exact: true })).toHaveAttribute(
    "href",
    `/app/rooms/${roomId}`,
  );
  if (await page.getByRole("button", { name: "채팅방 목록 열기", exact: true }).isVisible()) {
    const navigation = await roomNavigation(page);
    await navigation.getByRole("link", { name: "기기 검사방", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true })).toHaveCount(0);
  } else await page.getByRole("link", { name: "이전 채팅방으로", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/rooms/${roomId}$`));
  await expect(page.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
}
test("should retain an explicitly confirmed recovery command across reload and block changed tabs", async ({
  browser,
}, info) => {
  const a = await context(browser, info);
  try {
    const page = await a.newPage();
    await login(page, "복구 선택 소유자");
    const scope = await createRoom(page);
    await connectionsFromRoom(page, scope.roomId);
    const command = page.getByRole("textbox", { name: "로컬 연결 명령", exact: true });
    const copy = page.getByRole("button", { name: "연결 명령 복사", exact: true });
    await expect(copy).toBeEnabled();
    await page.getByText("명령 확인·직접 복사", { exact: true }).click();
    const defaultCommand = await command.inputValue();
    await page.getByRole("button", { name: "새 승인으로 다시 연결", exact: true }).click();
    await expect(copy).toBeDisabled();
    const prepare = page.getByRole("button", { name: "새 승인 명령 준비", exact: true });
    await expect(prepare).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "이전 연결의 터미널 실행을 종료했습니다", exact: true })
      .check();
    await prepare.click();
    await expect(copy).toBeEnabled();
    const selected = await command.inputValue();
    expect(selected).not.toBe(defaultCommand);
    await page.reload();
    await expect(copy).toBeEnabled();
    await page.getByText("명령 확인·직접 복사", { exact: true }).click();
    await expect(command).toHaveValue(selected);
    const other = await a.newPage();
    await other.goto(`/app/connections?room=${scope.roomId}`);
    await expect(other.getByRole("button", { name: "연결 명령 복사", exact: true })).toBeEnabled();
    await other.getByRole("button", { name: "새 승인으로 다시 연결", exact: true }).click();
    await other
      .getByRole("checkbox", { name: "이전 연결의 터미널 실행을 종료했습니다", exact: true })
      .check();
    await other.getByRole("button", { name: "새 승인 명령 준비", exact: true }).click();
    await expect(copy).toBeDisabled();
    await expect(command).toHaveValue("");
    await page.getByRole("button", { name: "현재 선택 다시 확인", exact: true }).click();
    await expect(copy).toBeEnabled();
    expect(await command.inputValue()).not.toBe(selected);
    await page.getByRole("link", { name: "이전 채팅방으로", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/rooms/${scope.roomId}$`));
    await expect(page.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
  } finally {
    await a.close();
  }
});

test("should approve an owned connection and display only public unverified bindings", async ({
  browser,
}, info) => {
  const a = await context(browser, info),
    b = await context(browser, info),
    observer = await context(browser, info);
  try {
    const ap = await a.newPage(),
      bp = await b.newPage(),
      op = await observer.newPage();
    const owner = await login(ap, "소유자"),
      participant = await login(bp, "참여자");
    await login(op, "관찰자");
    const scope = await createRoom(ap);
    await join(ap, bp, "participant");
    await join(ap, op, "observer");
    await connect(
      ap,
      owner.id,
      `owner-${info.project.name.includes("mobile") ? "mobile" : "desktop"}`,
      scope.roomId,
    );
    await connect(
      bp,
      participant.id,
      `participant-${info.project.name.includes("mobile") ? "mobile" : "desktop"}`,
      scope.roomId,
    );
    await op.goto(`/app/rooms/${scope.roomId}`);
    await revealRoomActions(op);
    const participantButton = op.getByRole("button", { name: "참가자 정보 열기", exact: true });
    if (await participantButton.isVisible()) await participantButton.click();
    const roster = op.getByRole("region", { name: "공개 기기 등록" });
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
    await expect(roster.getByText("등록 · 최근 통신 있음", { exact: true })).toHaveCount(2);
    await expect(roster).toContainText("codex");
    await expect(op.getByRole("button", { name: "기기 승인", exact: true })).toHaveCount(0);
    await connectionsFromRoom(op, scope.roomId);
    await expect(
      op.getByText("승인할 수 있는 참가 방이 없습니다.", { exact: false }),
    ).toBeVisible();
    await expect(op.getByRole("heading", { name: "내 연결", exact: true })).toBeVisible();
    await expect(op.getByText("연결된 기기가 없습니다.", { exact: false })).toBeVisible();
    await expect(op.getByRole("button", { name: "기기 승인", exact: true })).toHaveCount(0);
    await expect(op.getByRole("combobox", { name: "연결할 방", exact: true })).toHaveCount(0);
    await op.getByRole("link", { name: "이전 채팅방으로", exact: true }).click();
    await expect(op).toHaveURL(new RegExp(`/app/rooms/${scope.roomId}$`));
    await expect(op.getByRole("textbox", { name: "메시지", exact: true })).toHaveCount(0);
    await connectionsFromRoom(op, scope.roomId);
    await ap.goto("/app/connections");
    await ap.getByLabel("기기 연결 코드", { exact: true }).fill("0".repeat(64));
    await ap.getByRole("checkbox").check();
    await ap.getByRole("button", { name: "기기 승인", exact: true }).click();
    const error = ap.getByRole("alert", { name: "기기 연결 오류", exact: true });
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await ap.keyboard.press("Tab");
    check(await ap.locator("body").evaluate((el) => el.scrollWidth <= innerWidth + 1));
    const html = await op.content();
    check(
      !html.includes("private-native-") &&
        !html.includes("device-actual-") &&
        !html.includes("credentialHash") &&
        !html.includes("proofHash"),
    );
  } finally {
    await Promise.all([a.close(), b.close(), observer.close()]);
  }
});
test("should revoke a connection and require fresh approval after membership removal", async ({
  browser,
}, info) => {
  const a = await context(browser, info),
    b = await context(browser, info);
  try {
    const ap = await a.newPage(),
      bp = await b.newPage();
    const owner = await login(ap, "소유자"),
      member = await login(bp, "참여자");
    const scope = await createRoom(ap);
    await join(ap, bp, "participant");
    const suffix = info.project.name.includes("mobile") ? "mobile" : "desktop",
      own = `revoke-owner-${suffix}`,
      target = `revoke-member-${suffix}`;
    await connect(ap, owner.id, own, scope.roomId);
    await connect(bp, member.id, target, scope.roomId);
    await connectionsFromRoom(bp, scope.roomId);
    const currentConnections = bp
      .getByRole("heading", { name: "내 연결", exact: true })
      .locator("..");
    const removedCard = currentConnections
      .getByRole("listitem")
      .filter({ hasText: `기기 ${target}` });
    const removedId = await removedCard.getByLabel("공개 연결 ID", { exact: true }).textContent();
    check(removedId);
    await bp.getByRole("button", { name: `기기 ${target} 연결 취소`, exact: true }).click();
    await expect(
      currentConnections.getByText("취소됨 · 새 승인 필요", { exact: true }),
    ).toBeVisible();
    await expect(
      currentConnections.getByRole("button", { name: `기기 ${target} 기기 제거`, exact: true }),
    ).toBeVisible();
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: target })).status ===
        401,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: owner.id, name: own })).status === 200,
    );
    await bp.getByRole("button", { name: `기기 ${target} 기기 제거`, exact: true }).click();
    await expect(currentConnections.getByRole("listitem")).toHaveCount(0);
    await expect(
      currentConnections.getByText("연결된 기기가 없습니다.", { exact: false }),
    ).toBeVisible();
    const history = bp
      .locator("details")
      .filter({ has: bp.locator("summary", { hasText: "이전 연결 기록" }) });
    await expect(history).not.toHaveAttribute("open", "");
    await expect(history.getByText(`기기 ${target}`, { exact: true })).toBeHidden();
    await history.locator("summary").click();
    await expect(history.getByText("제거됨 · 새 승인 필요", { exact: true })).toBeVisible();
    await expect(history.getByLabel("공개 연결 ID", { exact: true })).toHaveText(removedId);
    await expect(history.getByRole("button")).toHaveCount(0);
    await expect(bp.getByText(`기기 ${target}`, { exact: true })).toHaveCount(1);
    const active = `active-member-${suffix}`;
    await connect(bp, member.id, active, scope.roomId);
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: active })).status ===
        200,
    );
    await ap.goto(`/app/rooms/${scope.roomId}`);
    const participantButton = ap.getByRole("button", { name: "참가자 정보 열기", exact: true });
    await revealRoomActions(ap);
    if (await participantButton.isVisible()) await participantButton.click();
    const roster = ap.getByRole("region", { name: "공개 기기 등록" });
    const memberBinding = roster.locator("li").filter({ hasText: `기기 ${active}` });
    await expect(memberBinding).toHaveCount(1);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
    await ap.keyboard.press("Escape");
    await revealRoomActions(ap);
    await ap.getByRole("button", { name: "채팅방 관리", exact: true }).click();
    await ap.getByRole("button", { name: "참여자 방에서 제거", exact: true }).click();
    await expect(ap.getByRole("button", { name: "참여자 방에서 제거", exact: true })).toHaveCount(
      0,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: active })).status ===
        401,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: owner.id, name: own })).status === 200,
    );
    await ap.reload();
    if (await participantButton.isVisible()) await participantButton.click();
    await expect(memberBinding).toHaveCount(0);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(1);
    await ap.keyboard.press("Escape");
    await join(ap, bp, "participant");
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: target })).status ===
        401,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: active })).status ===
        401,
    );
    await bp.goto("/app/connections");
    await expect(history).not.toHaveAttribute("open", "");
    await expect(history.getByText("제거됨 · 새 승인 필요", { exact: true })).toBeHidden();
    await expect(
      currentConnections.getByText("취소됨 · 새 승인 필요", { exact: true }),
    ).toBeVisible();
    await history.locator("summary").click();
    await expect(history.getByText("제거됨 · 새 승인 필요", { exact: true })).toBeVisible();
    await expect(history.getByLabel("공개 연결 ID", { exact: true })).toHaveText(removedId);
    await expect(history.getByRole("button")).toHaveCount(0);
    await history.locator("summary").click();
    await expect(history.getByText("제거됨 · 새 승인 필요", { exact: true })).toBeHidden();
    const appListReturn = bp.getByRole("link", { name: "채팅방 목록으로", exact: true });
    await expect(appListReturn).toHaveAttribute("href", "/app");
    await appListReturn.focus();
    await bp.keyboard.press("Enter");
    await expect(bp).toHaveURL(/\/app$/);
    await expect(bp.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    await connect(bp, member.id, `fresh-${suffix}`, scope.roomId);
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: active })).status ===
        401,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: owner.id, name: own })).status === 200,
    );
    await ap.reload();
    if (await participantButton.isVisible()) await participantButton.click();
    await expect(memberBinding).toHaveCount(0);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("should expose a valid room command and require explicit approval after a pairing fragment", async ({
  browser,
}, info) => {
  const a = await context(browser, info);
  try {
    const page = await a.newPage(),
      owner = await login(page, "연결 명령 소유자"),
      scope = await createRoom(page);
    const code = "a".repeat(64),
      sha = "b".repeat(64);
    await page.route("**/local-connection/manifest.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          code: { path: `/local-connection/connector-${sha}.tar.gz`, sha256: sha, bytes: 100 },
          bootstrap: { path: `/local-connection/bootstrap-${sha}.sh`, sha256: sha, bytes: 100 },
        }),
      }),
    );
    let approvals = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/connections/approve"))
        approvals++;
    });
    await page.goto(`/app/connections#code=${code}&room=${scope.roomId}`);
    await expect(page).toHaveURL(/\/app\/connections$/);
    await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue(code);
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    const guide = page.getByRole("region", { name: "명령 한 번으로 내 Mac 연결" });
    await expect(guide.getByRole("button", { name: "연결 명령 복사", exact: true })).toBeEnabled();
    await guide.getByText("명령 확인·직접 복사", { exact: true }).click();
    const command = await guide.getByLabel("로컬 연결 명령").inputValue();
    expect(command).toContain(scope.roomId);
    expect(command).toContain(scope.organizationId);
    expect(command).toContain("bootstrap-");
    expect(command).toContain(sha);
    expect(command).not.toContain(owner.id);
    expect(approvals).toBe(0);
    await guide.getByRole("button", { name: "연결 명령 복사", exact: true }).click();
    await expect(guide.getByRole("status", { name: "연결 명령 복사 결과" })).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.goto(`/app/connections#code=${code}&room=00000000-0000-4000-8000-000000000099`);
    await expect(page).toHaveURL(/\/app\/connections$/);
    await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue("");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await page.goto(`/app/connections#code=malformed&room=${scope.roomId}`);
    await expect(page).toHaveURL(/\/app\/connections$/);
    await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue("");
    expect(approvals).toBe(0);
    await connect(page, owner.id, `manual-${info.project.name}`, scope.roomId);
  } finally {
    await a.close();
  }
});

test("should preserve the owned status snapshot and chat draft across explicit refresh on every app screen", async ({
  browser,
}, info) => {
  const a = await context(browser, info),
    b = await context(browser, info);
  try {
    const ap = await a.newPage(),
      bp = await b.newPage();
    const owner = await login(ap, "통신 소유자"),
      member = await login(bp, "통신 참여자");
    const scope = await createRoom(ap);
    await join(ap, bp, "participant");
    const suffix = info.project.name.includes("mobile") ? "mobile" : "desktop";
    const first = `presence-work-${suffix}`,
      second = `presence-home-${suffix}`,
      other = `presence-other-${suffix}`;
    await connect(ap, owner.id, first, scope.roomId);
    await connect(ap, owner.id, second, scope.roomId);
    await connect(bp, member.id, other, scope.roomId);
    const bar = ap.getByRole("region", { name: "내 AI 연결 상태", exact: true });
    const checkedTime = bar.locator("time").first();
    const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const openDetails = async () => {
      if (!(await bar.locator("details").evaluate((element) => element.hasAttribute("open"))))
        await bar.locator("summary").click();
    };
    const expectOwnedStatus = async () => {
      await openDetails();
      await expect(bar).toBeVisible();
      await expect(bar.getByRole("status")).toContainText("최근 통신 확인 2/2대");
      await expect(bar.getByRole("status").locator('span[aria-hidden="true"]')).toHaveClass(
        /\bbg-green-600\b/,
      );
      await expect(checkedTime).toHaveAttribute("datetime", isoTimestamp);
      check(Number.isFinite(Date.parse((await checkedTime.getAttribute("datetime"))!)));
      await expect(checkedTime).toContainText("한국 시간");
      for (const name of [first, second]) {
        const device = bar.getByRole("listitem").filter({ hasText: `기기 ${name}` });
        await expect(device).toContainText("기기 검사방");
        await expect(device).toContainText("연결 통신 확인 · 최근 통신 확인");
        await expect(device.locator('span[aria-hidden="true"]')).toHaveClass(/\bbg-green-600\b/);
      }
      await expect(bar).not.toContainText(`기기 ${other}`);
      await expect(bar).toContainText("현재 AI 답변을 보장하지 않습니다");
    };
    await openDetails();
    await expect(checkedTime).toHaveAttribute("datetime", isoTimestamp);
    const beforeFirstRefresh = await checkedTime.getAttribute("datetime");
    check(beforeFirstRefresh);
    await bar.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(bar.getByRole("button", { name: "다시 확인", exact: true })).toBeEnabled();
    await expect(checkedTime).not.toHaveAttribute("datetime", beforeFirstRefresh);
    await expectOwnedStatus();
    // Navigation may receive a newer server snapshot; validate its meaning and ownership.
    const chatNavigation = await roomNavigation(ap);
    const appList = chatNavigation.getByRole("link", { name: "AI 채팅방", exact: true });
    await expect(appList).toHaveAttribute("href", "/app");
    await appList.click();
    await expect(ap).toHaveURL(/\/app$/);
    await expect(ap.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    await expectOwnedStatus();
    const roomLink = ap
      .getByRole("navigation", { name: "AI 채팅방 목록" })
      .getByRole("link", { name: "기기 검사방", exact: true });
    if (!(await roomLink.isVisible()))
      await ap.getByRole("button", { name: "채팅방 목록 열기", exact: true }).click();
    await ap
      .getByRole("navigation", { name: "AI 채팅방 목록" })
      .getByRole("link", { name: "기기 검사방", exact: true })
      .last()
      .click();
    await expect(ap.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
    await expectOwnedStatus();
    // Finish an explicit refresh on the final chat screen before observing passive time.
    const beforeChatRefresh = await checkedTime.getAttribute("datetime");
    check(beforeChatRefresh);
    await bar.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(bar.getByRole("button", { name: "다시 확인", exact: true })).toBeEnabled();
    await expect(checkedTime).not.toHaveAttribute("datetime", beforeChatRefresh);
    await expectOwnedStatus();
    const lastChecked = await checkedTime.getAttribute("datetime");
    check(lastChecked);
    await ap.getByRole("combobox", { name: "보낼 곳", exact: true }).selectOption("speak");
    const draft = ap.locator("#chat-message");
    await draft.fill("전송하지 않는 보존 검사 초안");
    const send = ap.getByRole("button", { name: "공동 발언 저장", exact: true });
    for (const target of [draft, send]) {
      const box = await target.boundingBox();
      const viewport = ap.viewportSize();
      check(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height + 1);
    }
    check(await ap.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1));
    await ap.clock.install();
    await ap.clock.fastForward(120_000);
    await expect(checkedTime).toHaveAttribute("datetime", lastChecked);
    await expectOwnedStatus();
    await expect(draft).toHaveValue("전송하지 않는 보존 검사 초안");
    check(
      (await broker<{ status: number }>("heartbeat", { id: owner.id, name: first })).status === 200,
    );
    await bar.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(bar.getByRole("button", { name: "다시 확인", exact: true })).toBeEnabled();
    await expect(checkedTime).not.toHaveAttribute("datetime", lastChecked);
    await expectOwnedStatus();
    await expect(draft).toHaveValue("전송하지 않는 보존 검사 초안");
    // Inject only the neutral status projection into the real refresh response.
    // Server lookup failures are covered separately by the owned snapshot unit test.
    await ap.route(
      `**/app/rooms/${scope.roomId}?*`,
      async (route) => {
        const response = await route.fetch();
        const original = await response.text();
        const neutral = JSON.stringify({
          state: "unavailable",
          checkedAt: new Date().toISOString(),
          activeCount: 0,
          connectedCount: 0,
          devices: [],
        });
        const body = original.replace(
          /\{"state":"(?:connected|unconfirmed)","checkedAt":"[^"]*","activeCount":\d+,"connectedCount":\d+,"devices":\[[^\n]*?\]\}/g,
          neutral,
        );
        check(body !== original);
        await route.fulfill({ response, body });
      },
      { times: 1 },
    );
    await bar.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(bar.getByRole("status")).toContainText("확인 불가");
    await expect(draft).toHaveValue("전송하지 않는 보존 검사 초안");
    await bar.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(bar.getByRole("status")).toContainText("최근 통신 확인 2/2대");
    await expect(draft).toHaveValue("전송하지 않는 보존 검사 초안");
    await openDetails();
    await bar.getByRole("link", { name: "연결 관리", exact: true }).click();
    await expect(
      ap.getByRole("heading", { name: "내 AI 연결", level: 1, exact: true }),
    ).toBeVisible();
    await expect(bar).toBeVisible();
    const settingsEnd = ap
      .getByRole("region", { name: "본인 기기 AI 설정", exact: true })
      .getByRole("link", { name: "이 AI 채팅방에서 질문만 하기", exact: true });
    await settingsEnd.scrollIntoViewIfNeeded();
    await expect(settingsEnd).toBeVisible();
    await expect(settingsEnd).toBeInViewport({ ratio: 1 });
    check(await ap.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1));
    await expect(ap.getByRole("main")).toHaveCount(1);
    const body = ap.getByRole("region", { name: "AI 연결 설정 내용", exact: true });
    await expect
      .poll(() =>
        body.evaluate((element) => ({
          overflowY: getComputedStyle(element).overflowY,
          hasOverflow: element.scrollHeight > element.clientHeight,
          scrolled: element.scrollTop > 0,
          atEnd: Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
        })),
      )
      .toEqual({ overflowY: "auto", hasOverflow: true, scrolled: true, atEnd: true });
    const ownSnapshot = await bar.textContent();
    check(ownSnapshot && !ownSnapshot.includes(`기기 ${other}`));
    const memberBar = bp.getByRole("region", { name: "내 AI 연결 상태", exact: true });
    await memberBar.locator("summary").click();
    await memberBar.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(memberBar).toContainText(`기기 ${other}`);
    await expect(memberBar).not.toContainText(`기기 ${first}`);
    await ap.getByRole("link", { name: "채팅방 목록으로", exact: true }).click();
    await revealRoomActions(ap);
    await ap.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(ap).toHaveURL(/\/login$/);
    await expect(bar).toHaveCount(0);
    await login(ap, "새 통신 소유자");
    await expect(bar.getByRole("status")).toContainText("연결 확인 안 됨");
    await expect(bar.getByRole("status").locator('span[aria-hidden="true"]')).toHaveClass(
      /\bbg-red-600\b/,
    );
    await expect(checkedTime).toHaveAttribute("datetime", isoTimestamp);
    await bar.getByText("기기별 연결 상세", { exact: true }).click();
    await expect(bar).toContainText("활성 등록 기기가 없습니다");
    await expect(bar).not.toContainText(`기기 ${first}`);
    await expect(bar).not.toContainText(`기기 ${second}`);
    await ap.goBack();
    await expect(ap).toHaveURL(/\/app(?:\/|$)/);
    await expect(bar.getByRole("status")).toContainText("연결 확인 안 됨");
    await expect(bar.getByRole("status").locator('span[aria-hidden="true"]')).toHaveClass(
      /\bbg-red-600\b/,
    );
    await expect(checkedTime).toHaveAttribute("datetime", isoTimestamp);
    await expect(ap.locator("body")).not.toContainText(`기기 ${first}`);
    await expect(ap.locator("body")).not.toContainText(`기기 ${second}`);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

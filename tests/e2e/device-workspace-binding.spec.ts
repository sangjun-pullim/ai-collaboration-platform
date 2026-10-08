import { test, expect, type Browser, type TestInfo, type Page } from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);
import { enterTeam, type BrowserEntry, type BrowserPerson } from "../helpers/browser-team-entry.js";
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
async function connect(page: Page, id: string, name: string, roomId: string) {
  const p = await broker<{ name: string; code: string }>("pair", { id, name });
  await page.goto("/app/connections");
  await page.getByRole("combobox", { name: "연결할 방", exact: true }).selectOption(roomId);
  await page.getByLabel("기기 연결 코드", { exact: true }).fill(p.code);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "기기 승인", exact: true }).click();
  await expect(page.getByRole("status", { name: "기기 연결 결과" })).toContainText("승인을 완료");
  await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue("");
  await broker("register", { id, name });
  await page.reload();
  await expect(page.getByText("등록 · 실행 미검증", { exact: true })).toBeVisible();
}
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
    const participantButton = op.getByRole("button", { name: "참가자 정보 열기", exact: true });
    if (await participantButton.isVisible()) await participantButton.click();
    const roster = op.getByRole("region", { name: "공개 기기 등록" });
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
    await expect(roster.getByText("등록 · 최근 통신 있음", { exact: true })).toHaveCount(2);
    await expect(roster).toContainText("codex");
    await expect(op.getByRole("button", { name: "기기 승인", exact: true })).toHaveCount(0);
    await op.goto("/app/connections");
    await expect(
      op.getByText("승인할 수 있는 참가 방이 없습니다.", { exact: false }),
    ).toBeVisible();
    await expect(op.getByRole("heading", { name: "내 연결", exact: true })).toBeVisible();
    await expect(op.getByText("연결된 기기가 없습니다.", { exact: false })).toBeVisible();
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
    await bp.getByRole("button", { name: `기기 ${target} 연결 취소`, exact: true }).click();
    await expect(bp.getByText("취소됨 · 새 승인 필요", { exact: true })).toBeVisible();
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: target })).status ===
        401,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: owner.id, name: own })).status === 200,
    );
    await bp.getByRole("button", { name: `기기 ${target} 기기 제거`, exact: true }).click();
    await expect(bp.getByText("제거됨 · 새 승인 필요", { exact: true })).toBeVisible();
    const active = `active-member-${suffix}`;
    await connect(bp, member.id, active, scope.roomId);
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: active })).status ===
        200,
    );
    await ap.goto(`/app/rooms/${scope.roomId}`);
    const participantButton = ap.getByRole("button", { name: "참가자 정보 열기", exact: true });
    if (await participantButton.isVisible()) await participantButton.click();
    const roster = ap.getByRole("region", { name: "공개 기기 등록" });
    const memberBinding = roster.locator("li").filter({ hasText: `기기 ${active}` });
    await expect(memberBinding).toHaveCount(1);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
    await ap.keyboard.press("Escape");
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
    await expect(bp.getByText("제거됨 · 새 승인 필요", { exact: true })).toBeVisible();
    await expect(bp.getByText("취소됨 · 새 승인 필요", { exact: true })).toBeVisible();
    await bp.getByRole("link", { name: "내 AI 채팅방", exact: true }).focus();
    await bp.keyboard.press("Enter");
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
    await page.goto(`/app/connections#code=${code}&room=00000000-0000-4000-8000-000000000099`);
    await expect(page).toHaveURL(/\/app\/connections$/);
    await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue("");
    await page.goto(`/app/connections#code=malformed&room=${scope.roomId}`);
    await expect(page).toHaveURL(/\/app\/connections$/);
    await expect(page.getByLabel("기기 연결 코드", { exact: true })).toHaveValue("");
    expect(approvals).toBe(0);
    await connect(page, owner.id, `manual-${info.project.name}`, scope.roomId);
  } finally {
    await a.close();
  }
});

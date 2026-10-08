import { test, expect, type Browser, type TestInfo, type Page } from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);
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
async function login(page: Page) {
  const p = await broker<{ id: string; email: string }>("person", {});
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(p.email);
  await page.getByRole("button", { name: "코드 받기", exact: true }).click();
  await expect(page.getByLabel("로그인 코드", { exact: true })).toBeVisible();
  const otp = await broker<{ code: string }>("code", { id: p.id });
  await page.getByLabel("로그인 코드", { exact: true }).fill(otp.code);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 조사방", exact: true })).toBeVisible();
  return p;
}
async function createRoom(page: Page) {
  const section = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "새 그룹과 첫 방 만들기", exact: true }) });
  for (const [label, value] of [
    ["그룹 이름", "연결 검사 그룹"],
    ["방 이름", "기기 검사방"],
    ["조사 목표", "합성 목표"],
    ["관찰 근거", "합성 근거"],
    ["환경", "격리 환경"],
    ["내 별칭", "소유자"],
  ])
    await section.getByLabel(label, { exact: true }).fill(value);
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/access/bootstrap"),
  );
  await section.getByRole("button", { name: "그룹과 방 만들기", exact: true }).click();
  const result = await (await response).json();
  check(result.ok);
  await broker("track", { organizationId: result.data.organizationId });
  await expect(page.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
  return result.data as { roomId: string; organizationId: string };
}
async function join(owner: Page, member: Page, role: string) {
  await owner.getByRole("combobox", { name: "초대 역할", exact: true }).selectOption(role);
  await owner.getByRole("button", { name: "초대 발급", exact: true }).click();
  const output = owner.getByLabel("발급된 초대 코드", { exact: true });
  await expect(output).toBeVisible();
  const code = await output.textContent();
  check(code);
  await member.goto("/app");
  await member.getByLabel("초대 코드", { exact: true }).fill(code);
  await member
    .getByLabel("내 별칭", { exact: true })
    .first()
    .fill(role === "observer" ? "관찰자" : "참여자");
  await member.getByRole("button", { name: "방 참가", exact: true }).click();
  await expect(member.getByRole("heading", { name: "기기 검사방", exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "코드 숨기기", exact: true }).click();
}
async function connect(page: Page, id: string, name: string, roomId: string) {
  const p = await broker<{ name: string; code: string }>("pair", { id, name });
  await page.goto("/app/connections");
  await page.getByRole("combobox", { name: "연결할 방", exact: true }).selectOption(roomId);
  await page.getByLabel("기기 연결 코드", { exact: true }).fill(p.code);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "기기 승인", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("승인을 완료");
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
    const owner = await login(ap),
      participant = await login(bp);
    await login(op);
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
    const roster = op.getByRole("region", { name: "공개 기기 등록" });
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
    await expect(roster.getByText("등록 · 실행 미검증", { exact: true })).toHaveCount(2);
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
    const owner = await login(ap),
      member = await login(bp);
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
    const roster = ap.getByRole("region", { name: "공개 기기 등록" });
    const memberBinding = roster.locator("li").filter({ hasText: `기기 ${active}` });
    await expect(memberBinding).toHaveCount(1);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
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
    await expect(memberBinding).toHaveCount(0);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(1);
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
    await bp.getByRole("link", { name: "내 조사방", exact: true }).focus();
    await bp.keyboard.press("Enter");
    await expect(bp.getByRole("heading", { name: "내 조사방", exact: true })).toBeVisible();
    await connect(bp, member.id, `fresh-${suffix}`, scope.roomId);
    check(
      (await broker<{ status: number }>("heartbeat", { id: member.id, name: active })).status ===
        401,
    );
    check(
      (await broker<{ status: number }>("heartbeat", { id: owner.id, name: own })).status === 200,
    );
    await ap.reload();
    await expect(memberBinding).toHaveCount(0);
    await expect(roster.getByText("공개 저장소 · 공개 세션", { exact: true })).toHaveCount(2);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

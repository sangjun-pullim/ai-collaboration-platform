import {
  test,
  expect,
  type Page,
  type Browser,
  type BrowserContext,
  type TestInfo,
} from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);
const stages = [
  "test.start",
  "test.contexts-ready",
  "test.pages-ready",
  "test.owner-ready",
  "test.room-ready",
  "test.additional-room-start",
  "test.additional-room-ready",
  "test.invitation-ready",
  "test.member-ready",
  "test.member-joined",
  "test.role-checked",
  "test.reload-checked",
  "test.hidden-room-checked",
  "test.cookies-checked",
  "test.invite-secrets-checked",
  "test.cache-checked",
  "test.logout-start",
  "test.logout-checked",
  "test.logged-out-room-checked",
  "test.other-session-checked",
  "test.observer-ready",
  "test.observer-joined",
  "test.extra-member-ready",
  "test.extra-member-joined",
  "test.observer-ui-checked",
  "test.observer-api-checked",
  "test.owner-self-remove-checked",
  "test.remove-start",
  "test.member-removed",
  "test.removed-room-checked",
  "test.error-recovery-start",
  "test.error-submit-complete",
  "test.error-visible",
  "test.error-focused",
  "test.keyboard-recovery-checked",
  "test.mobile-layout-checked",
  "test.identities-checked",
  "test.cleanup-start",
  "test.cleanup-complete",
  "login.start",
  "login.person-ready",
  "login.page-loaded",
  "login.email-filled",
  "login.code-clicked",
  "login.otp-visible",
  "login.broker-code-obtained",
  "login.otp-filled",
  "login.verify-clicked",
  "login.dashboard-visible",
  "create-room.start",
  "create-room.fields-filled",
  "create-room.clicked",
  "create-room.result-checked",
  "create-room.tracked",
  "create-room.visible",
  "issue-invite.start",
  "issue-invite.role-selected",
  "issue-invite.clicked",
  "issue-invite.visible",
  "issue-invite.checked",
  "join.start",
  "join.fields-filled",
  "join.clicked",
  "join.room-visible",
] as const;
const responsePaths = {
  "login.code-response": "/api/auth/code",
  "login.verify-response": "/api/auth/verify",
  "create-room.response": "/api/access/bootstrap",
  "issue-invite.response": "/api/access/invite",
  "join.response": "/api/access/join",
  "test.additional-room-response": "/api/access/room",
  "test.logout-response": "/api/auth/logout",
  "test.remove-response": "/api/access/revoke-room-member",
} as const;
type ResponseStage = keyof typeof responsePaths;
type Stage = (typeof stages)[number] | ResponseStage;
type DiagnosticTest = "invited-room" | "observer-removal";
function diagnostics(testCase: DiagnosticTest, info: TestInfo) {
  const project =
    info.project.name === "auth-desktop-chromium"
      ? "desktop"
      : info.project.name === "auth-mobile-chromium"
        ? "mobile"
        : "other";
  let lastStage: Stage = "test.start";
  function emit(stage: Stage, phase: "checkpoint" | "finally", status?: number) {
    // Never copy labels, URLs, DOM, fixture values or errors into these diagnostics.
    console.log(
      JSON.stringify({
        test: testCase,
        project,
        stage,
        phase,
        ...(status === undefined ? {} : { status }),
      }),
    );
  }
  return {
    mark(stage: Stage) {
      lastStage = stage;
      emit(stage, "checkpoint");
    },
    wait(page: Page, stage: ResponseStage) {
      // Register before clicking; swallow waiter rejection without forwarding any error payload.
      return page
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().endsWith(responsePaths[stage]),
        )
        .then((response) => {
          const status = response.status();
          if (Number.isInteger(status) && status >= 100 && status <= 599) {
            lastStage = stage;
            emit(stage, "checkpoint", status);
          }
          return response;
        })
        .catch(() => null);
    },
    finish() {
      emit(lastStage, "finally");
    },
  };
}
type Diagnostics = ReturnType<typeof diagnostics>;
function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function broker<T>(action: string, body: unknown): Promise<T> {
  const endpoint = process.env.LOCAL_ACCESS_FIXTURE_URL;
  const token = process.env.LOCAL_ACCESS_FIXTURE_TOKEN;
  requireCheck(
    endpoint && token && new URL(endpoint).hostname === "127.0.0.1",
    "Owned browser fixture parent is required",
  );
  const response = await fetch(`${endpoint}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  requireCheck(response.ok, "Owned browser fixture action failed");
  return response.json() as Promise<T>;
}
async function context(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  return browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
    baseURL: process.env.APP_ORIGIN,
  });
}
async function login(page: Page, label: string, diagnostic: Diagnostics) {
  diagnostic.mark("login.start");
  try {
    const person = await broker<{ id: string; email: string }>("person", { label });
    diagnostic.mark("login.person-ready");
    await page.goto("/login");
    diagnostic.mark("login.page-loaded");
    await page.getByLabel("이메일", { exact: true }).fill(person.email);
    diagnostic.mark("login.email-filled");
    const codeResponse = diagnostic.wait(page, "login.code-response");
    await page.getByRole("button", { name: "코드 받기", exact: true }).click();
    diagnostic.mark("login.code-clicked");
    await codeResponse;
    await expect(page.getByLabel("로그인 코드", { exact: true })).toBeVisible();
    diagnostic.mark("login.otp-visible");
    const { code } = await broker<{ code: string }>("code", { id: person.id });
    diagnostic.mark("login.broker-code-obtained");
    await page.getByLabel("로그인 코드", { exact: true }).fill(code);
    diagnostic.mark("login.otp-filled");
    const verifyResponse = diagnostic.wait(page, "login.verify-response");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    diagnostic.mark("login.verify-clicked");
    await verifyResponse;
    await expect(page.getByRole("heading", { name: "내 조사방", exact: true })).toBeVisible();
    diagnostic.mark("login.dashboard-visible");
    return person;
  } finally {
    diagnostic.finish();
  }
}
async function createRoom(page: Page, diagnostic: Diagnostics) {
  diagnostic.mark("create-room.start");
  try {
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "새 그룹과 첫 방 만들기", exact: true }) });
    await section.getByLabel("그룹 이름", { exact: true }).fill("브라우저 합성 그룹");
    await section.getByLabel("방 이름", { exact: true }).fill("초대된 조사방");
    await section.getByLabel("조사 목표", { exact: true }).fill("브라우저 권한 확인");
    await section.getByLabel("관찰 근거", { exact: true }).fill("합성 관찰");
    await section.getByLabel("환경", { exact: true }).fill("격리 환경");
    await section.getByLabel("내 별칭", { exact: true }).fill("소유자");
    diagnostic.mark("create-room.fields-filled");
    const response = diagnostic.wait(page, "create-room.response");
    await section.getByRole("button", { name: "그룹과 방 만들기", exact: true }).click();
    diagnostic.mark("create-room.clicked");
    const received = await response;
    requireCheck(received, "Expected the fixed bootstrap response");
    const result = await received.json();
    requireCheck(result.ok, "Browser bootstrap should succeed");
    diagnostic.mark("create-room.result-checked");
    await broker("track", { organizationId: result.data.organizationId });
    diagnostic.mark("create-room.tracked");
    await expect(page.getByRole("heading", { name: "초대된 조사방", exact: true })).toBeVisible();
    diagnostic.mark("create-room.visible");
    return result.data as { roomId: string; organizationId: string };
  } finally {
    diagnostic.finish();
  }
}
async function issueInvite(page: Page, role: string, diagnostic: Diagnostics) {
  diagnostic.mark("issue-invite.start");
  try {
    await page.getByRole("combobox", { name: "초대 역할", exact: true }).selectOption(role);
    diagnostic.mark("issue-invite.role-selected");
    const response = diagnostic.wait(page, "issue-invite.response");
    await page.getByRole("button", { name: "초대 발급", exact: true }).click();
    diagnostic.mark("issue-invite.clicked");
    await response;
    const output = page.getByLabel("발급된 초대 코드", { exact: true });
    await expect(output).toBeVisible();
    diagnostic.mark("issue-invite.visible");
    const code = await output.textContent();
    requireCheck(
      code && /^[a-f0-9]{64}$/.test(code),
      "Browser should display a one-time invitation",
    );
    requireCheck(!page.url().includes(code), "Invitation should never be in the browser URL");
    diagnostic.mark("issue-invite.checked");
    return code;
  } finally {
    diagnostic.finish();
  }
}
async function join(page: Page, code: string, alias: string, diagnostic: Diagnostics) {
  diagnostic.mark("join.start");
  try {
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "초대로 참가", exact: true }) });
    await section.getByLabel("초대 코드", { exact: true }).fill(code);
    await section.getByLabel("내 별칭", { exact: true }).fill(alias);
    diagnostic.mark("join.fields-filled");
    const response = diagnostic.wait(page, "join.response");
    await section.getByRole("button", { name: "방 참가", exact: true }).click();
    diagnostic.mark("join.clicked");
    await response;
    await expect(page.getByRole("heading", { name: "초대된 조사방", exact: true })).toBeVisible();
    diagnostic.mark("join.room-visible");
  } finally {
    diagnostic.finish();
  }
}

test("should allow two authenticated browsers to join only the invited room", async ({
  browser,
}, info) => {
  const diagnostic = diagnostics("invited-room", info);
  const contexts: BrowserContext[] = [];
  diagnostic.mark("test.start");
  try {
    const a = await context(browser, info);
    contexts.push(a);
    const b = await context(browser, info);
    contexts.push(b);
    diagnostic.mark("test.contexts-ready");
    const ap = await a.newPage();
    const bp = await b.newPage();
    diagnostic.mark("test.pages-ready");
    await login(ap, `${info.project.name}-owner`, diagnostic);
    diagnostic.mark("test.owner-ready");
    const scope = await createRoom(ap, diagnostic);
    diagnostic.mark("test.room-ready");
    diagnostic.mark("test.additional-room-start");
    await ap.getByRole("link", { name: "내 조사방", exact: true }).click();
    const section = ap
      .locator("section")
      .filter({ has: ap.getByRole("heading", { name: "내 그룹에 방 추가", exact: true }) });
    for (const [name, value] of [
      ["방 이름", "비초대 방"],
      ["조사 목표", "목표"],
      ["관찰 근거", "근거"],
      ["환경", "환경"],
    ])
      await section.getByLabel(name, { exact: true }).fill(value);
    const created = diagnostic.wait(ap, "test.additional-room-response");
    await section.getByRole("button", { name: "방 만들기", exact: true }).click();
    const received = await created;
    requireCheck(received, "Expected the fixed room creation response");
    const second = await received.json();
    requireCheck(second.ok, "Owner should create another room");
    diagnostic.mark("test.additional-room-ready");
    await ap.goto(`/app/rooms/${scope.roomId}`);
    const code = await issueInvite(ap, "participant", diagnostic);
    diagnostic.mark("test.invitation-ready");
    await login(bp, `${info.project.name}-participant`, diagnostic);
    diagnostic.mark("test.member-ready");
    await join(bp, code, "참여자B", diagnostic);
    diagnostic.mark("test.member-joined");
    await expect(bp.getByText("내 역할:")).toContainText("참여자");
    diagnostic.mark("test.role-checked");
    await bp.reload();
    await expect(bp.getByRole("heading", { name: "방 준비 정보", exact: true })).toBeVisible();
    await expect(
      bp.getByText("기기 등록은 가능하며 AI 실행은 아직 미검증입니다.", { exact: false }),
    ).toBeVisible();
    diagnostic.mark("test.reload-checked");
    const hidden = await b.request.get(`/app/rooms/${second.data.roomId}`);
    requireCheck(hidden.status() === 404, "Same-organization uninvited room must be blocked");
    diagnostic.mark("test.hidden-room-checked");
    const cookiesA = await a.cookies();
    const cookiesB = await b.cookies();
    requireCheck(
      cookiesA.length > 0 &&
        cookiesB.length > 0 &&
        cookiesA.every((cookie) => cookie.httpOnly && cookie.sameSite === "Lax"),
      "Auth browser cookies should be server-only and isolated",
    );
    requireCheck(
      cookiesA.map((c) => c.value).join("") !== cookiesB.map((c) => c.value).join(""),
      "Browser contexts must have distinct session cookies",
    );
    diagnostic.mark("test.cookies-checked");
    requireCheck(
      !(await bp.content()).includes(code),
      "Participant's room must not contain the issuer's invitation secret",
    );
    await ap.reload();
    requireCheck(
      !(await ap.content()).includes(code),
      "Issued invitation is not persisted into fresh page HTML",
    );
    diagnostic.mark("test.invite-secrets-checked");
    const response = await b.request.get("/app");
    requireCheck(
      response.headers()["cache-control"].includes("no-store"),
      "Personalized browser response must be private",
    );
    diagnostic.mark("test.cache-checked");
    diagnostic.mark("test.logout-start");
    const logoutResponse = diagnostic.wait(ap, "test.logout-response");
    await ap.getByRole("button", { name: "로그아웃", exact: true }).click();
    await logoutResponse;
    await expect(ap.getByRole("heading", { name: "조사실 로그인", exact: true })).toBeVisible();
    diagnostic.mark("test.logout-checked");
    await ap.goto(`/app/rooms/${scope.roomId}`);
    await expect(ap.getByRole("heading", { name: "조사실 로그인", exact: true })).toBeVisible();
    diagnostic.mark("test.logged-out-room-checked");
    await bp.reload();
    await expect(bp.getByRole("heading", { name: "초대된 조사방", exact: true })).toBeVisible();
    diagnostic.mark("test.other-session-checked");
  } finally {
    diagnostic.finish();
    diagnostic.mark("test.cleanup-start");
    try {
      for (const item of contexts) await item.close();
      diagnostic.mark("test.cleanup-complete");
    } finally {
      diagnostic.finish();
    }
  }
});

test("should enforce observer and owner controls after a member is removed", async ({
  browser,
}, info) => {
  const diagnostic = diagnostics("observer-removal", info);
  const contexts: BrowserContext[] = [];
  diagnostic.mark("test.start");
  try {
    const a = await context(browser, info);
    contexts.push(a);
    const b = await context(browser, info);
    contexts.push(b);
    const memberContext = await context(browser, info);
    contexts.push(memberContext);
    diagnostic.mark("test.contexts-ready");
    const ap = await a.newPage();
    const bp = await b.newPage();
    const memberPage = await memberContext.newPage();
    diagnostic.mark("test.pages-ready");
    const owner = await login(ap, `${info.project.name}-owner-revoke`, diagnostic);
    diagnostic.mark("test.owner-ready");
    const scope = await createRoom(ap, diagnostic);
    diagnostic.mark("test.room-ready");
    const code = await issueInvite(ap, "observer", diagnostic);
    diagnostic.mark("test.invitation-ready");
    const observer = await login(bp, `${info.project.name}-observer`, diagnostic);
    diagnostic.mark("test.observer-ready");
    await join(bp, code, "관찰자B", diagnostic);
    diagnostic.mark("test.observer-joined");
    const memberCode = await issueInvite(ap, "participant", diagnostic);
    diagnostic.mark("test.invitation-ready");
    await login(memberPage, `${info.project.name}-non-owner-member`, diagnostic);
    diagnostic.mark("test.extra-member-ready");
    await join(memberPage, memberCode, "참여자C", diagnostic);
    diagnostic.mark("test.extra-member-joined");
    await bp.reload();
    await expect(bp.getByText("참여자C · 참여자", { exact: true })).toBeVisible();
    await expect(bp.getByText("내 역할:")).toContainText("관찰자");
    await expect(bp.getByRole("button", { name: "초대 발급", exact: true })).toHaveCount(0);
    await expect(bp.getByRole("button", { name: /방에서 제거$/ })).toHaveCount(0);
    await expect(bp.getByRole("button", { name: "참여자C 방에서 제거", exact: true })).toHaveCount(
      0,
    );
    diagnostic.mark("test.observer-ui-checked");
    const forbidden = await b.request.post("/api/access/invite", {
      headers: { Origin: process.env.APP_ORIGIN! },
      data: { roomId: scope.roomId, role: "participant" },
    });
    requireCheck(
      forbidden.status() === 403 && (await forbidden.json()).error.code === "FORBIDDEN",
      "Observer API authority must be enforced independently of UI",
    );
    diagnostic.mark("test.observer-api-checked");
    const selfRemove = await a.request.post("/api/access/revoke-room-member", {
      headers: { Origin: process.env.APP_ORIGIN! },
      data: { roomId: scope.roomId, userId: owner.id },
    });
    requireCheck(selfRemove.status() === 403, "Owner self-removal must be blocked");
    diagnostic.mark("test.owner-self-remove-checked");
    diagnostic.mark("test.remove-start");
    await ap.reload();
    const removed = diagnostic.wait(ap, "test.remove-response");
    await ap.getByRole("button", { name: "관찰자B 방에서 제거", exact: true }).click();
    const removeResponse = await removed;
    requireCheck(removeResponse?.status() === 200, "Owner should remove an observer");
    await expect(ap.getByText("관찰자B · 관찰자", { exact: true })).toHaveCount(0);
    diagnostic.mark("test.member-removed");
    const roomRead = await b.request.get(`/app/rooms/${scope.roomId}`);
    requireCheck(
      roomRead.status() === 404,
      "Removed member's current Auth session must lose room access",
    );
    diagnostic.mark("test.removed-room-checked");
    diagnostic.mark("test.error-recovery-start");
    await bp.goto("/app");
    const section = bp
      .locator("section")
      .filter({ has: bp.getByRole("heading", { name: "초대로 참가", exact: true }) });
    await section.getByLabel("초대 코드", { exact: true }).fill(code);
    await section.getByLabel("내 별칭", { exact: true }).fill("관찰자B");
    await section.getByRole("button", { name: "방 참가", exact: true }).focus();
    const rejectedJoin = diagnostic.wait(bp, "join.response");
    await bp.keyboard.press("Enter");
    requireCheck(
      (await rejectedJoin)?.status() === 409,
      "Old invitation submission must be rejected with HTTP 409",
    );
    diagnostic.mark("test.error-submit-complete");
    const error = bp
      .getByRole("alert")
      .filter({ hasText: "초대가 만료되었거나 취소되었습니다. 새 초대를 요청하세요." });
    await expect(error).toBeVisible();
    diagnostic.mark("test.error-visible");
    await expect(error).toBeFocused();
    diagnostic.mark("test.error-focused");
    requireCheck(
      !(await error.textContent())?.includes(code),
      "Error must not reveal the invitation secret",
    );
    await bp.keyboard.press("Tab");
    await expect(section.getByLabel("초대 코드", { exact: true })).toBeFocused();
    diagnostic.mark("test.keyboard-recovery-checked");
    requireCheck(
      await bp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "Error recovery must fit the mobile viewport",
    );
    diagnostic.mark("test.mobile-layout-checked");
    requireCheck(observer.id !== owner.id, "Observer and owner must be separate fixture accounts");
    diagnostic.mark("test.identities-checked");
  } finally {
    diagnostic.finish();
    diagnostic.mark("test.cleanup-start");
    try {
      for (const item of contexts) await item.close();
      diagnostic.mark("test.cleanup-complete");
    } finally {
      diagnostic.finish();
    }
  }
});

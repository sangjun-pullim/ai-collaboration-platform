import {
  test,
  expect,
  type Page,
  type Browser,
  type BrowserContext,
  type TestInfo,
  type Response,
} from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);
import {
  enterTeam,
  prepareTeamEntry,
  submitTeamEntry,
  type BrowserEntry,
  type BrowserPerson,
} from "../helpers/browser-team-entry.js";
type Stages = [
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
  "test.observer-details-opened",
  "test.observer-details-checked",
  "test.observer-details-closed",
  "test.observer-management-opened",
  "test.observer-ui-checked",
  "test.entry-form-visible",
  "test.entry-code-rejected",
  "test.entry-code-cleared",
  "test.entry-name-retained",
  "test.entry-error-focused",
  "test.entry-code-focused",
  "test.entry-retry-complete",
  "test.entry-reconnect-complete",
  "test.mobile-create-navigation-opened",
  "test.mobile-create-triggered",
  "test.mobile-create-dialog-visible",
  "test.mobile-create-focus-restored",
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
];
const responsePaths = {
  "create-room.response": "/api/access/bootstrap",
  "issue-invite.response": "/api/access/invite",
  "join.response": "/api/access/join",
  "test.additional-room-response": "/api/access/room",
  "test.logout-response": "/api/auth/logout",
  "test.remove-response": "/api/access/revoke-room-member",
  "test.entry-rejected-response": "/api/auth/enter",
} as const;
type ResponseStage = keyof typeof responsePaths;
type Stage = Stages[number] | ResponseStage;
type DiagnosticTest = "invited-room" | "observer-removal" | "entry-recovery" | "mobile-room-create";
function diagnostics(testCase: DiagnosticTest, info: TestInfo) {
  const project =
    info.project.name === "auth-desktop-chromium"
      ? "desktop"
      : info.project.name === "auth-mobile-chromium"
        ? "mobile"
        : "other";
  let lastStage: Stage = "test.start";
  function emit(stage: Stage, phase: "checkpoint" | "finally", status?: number, matched?: boolean) {
    // Never copy labels, URLs, DOM, fixture values or errors into these diagnostics.
    console.log(
      JSON.stringify({
        test: testCase,
        project,
        stage,
        phase,
        ...(status === undefined ? {} : { status }),
        ...(matched === undefined ? {} : { matched }),
      }),
    );
  }
  return {
    mark(stage: Stage) {
      lastStage = stage;
      emit(stage, "checkpoint");
    },
    probe(stage: Stage, matched: boolean) {
      lastStage = stage;
      emit(stage, "checkpoint", undefined, matched);
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
type BrowserReservation = { reservationId: string; displayName: string; code: string };
async function claimFreshResponse(
  owned: BrowserContext,
  response: Response,
  reservation: BrowserReservation,
) {
  const body = await response.json();
  requireCheck(
    response.status() === 200 && body.ok === true && typeof body.data?.userId === "string",
    "Fresh owned entry response failed",
  );
  const userId: string = body.data.userId;
  const cookies = (await owned.cookies()).filter(
    (cookie) => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name) && cookie.value,
  );
  const claimed = await broker<BrowserPerson>("claim-entry", {
    reservationId: reservation.reservationId,
    userId,
    cookies: cookies.map(({ name, value }) => ({ name, value })),
  });
  requireCheck(
    claimed.id === userId && claimed.displayName === reservation.displayName,
    "Fresh entry cleanup identity failed",
  );
  return { userId, cookies };
}
async function context(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  return browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
    baseURL: process.env.APP_ORIGIN,
  });
}
async function login(page: Page, label: string, displayName: string, diagnostic: Diagnostics) {
  diagnostic.mark("login.start");
  try {
    const person = await broker<BrowserPerson>("person", { label });
    diagnostic.mark("login.person-ready");
    await enterTeam(
      page,
      person,
      () => broker<BrowserEntry>("code", { id: person.id }),
      displayName,
    );
    diagnostic.mark("login.dashboard-visible");
    return person;
  } finally {
    diagnostic.finish();
  }
}

async function createRoom(page: Page, diagnostic: Diagnostics) {
  diagnostic.mark("create-room.start");
  try {
    await page.getByRole("button", { name: "새 채팅방", exact: true }).click();
    const section = page.getByRole("dialog", { name: "새 채팅방", exact: true });
    await section.getByLabel("방 이름", { exact: true }).fill("초대된 조사방");
    diagnostic.mark("create-room.fields-filled");
    const response = diagnostic.wait(page, "create-room.response");
    await section.getByRole("button", { name: "방 만들기", exact: true }).click();
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
    await page.getByRole("button", { name: "채팅방 관리", exact: true }).click();
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
    await page.keyboard.press("Escape");
    return code;
  } finally {
    diagnostic.finish();
  }
}
async function join(page: Page, code: string, diagnostic: Diagnostics) {
  diagnostic.mark("join.start");
  try {
    await page.getByRole("button", { name: "초대로 참가", exact: true }).click();
    const section = page.getByRole("dialog", { name: "초대로 참가", exact: true });
    await section.getByLabel("초대 코드", { exact: true }).fill(code);
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
    await login(ap, `${info.project.name}-owner`, "소유자", diagnostic);
    diagnostic.mark("test.owner-ready");
    const scope = await createRoom(ap, diagnostic);
    diagnostic.mark("test.room-ready");
    diagnostic.mark("test.additional-room-start");
    const menu = ap.getByRole("button", { name: "채팅방 목록 열기", exact: true });
    if (await menu.isVisible()) {
      await menu.click();
      const navigation = ap.getByRole("dialog", { name: "AI 채팅방 목록", exact: true });
      await expect(navigation).toBeVisible();
      await navigation.getByRole("link", { name: "AI 채팅방", exact: true }).click();
      await expect(navigation).toHaveCount(0);
    } else {
      await ap
        .getByRole("complementary", { name: "채팅방 탐색", exact: true })
        .getByRole("link", { name: "AI 채팅방", exact: true })
        .click();
    }
    await expect(ap.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    await ap.getByRole("button", { name: "새 채팅방", exact: true }).click();
    const section = ap.getByRole("dialog", { name: "새 채팅방", exact: true });
    await section.getByLabel("방 이름", { exact: true }).fill("비초대 방");
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
    await login(bp, `${info.project.name}-participant`, "참여자B", diagnostic);
    diagnostic.mark("test.member-ready");
    await join(bp, code, diagnostic);
    diagnostic.mark("test.member-joined");
    await expect(bp.getByText("내 역할:")).toContainText("참여자");
    diagnostic.mark("test.role-checked");
    await bp.reload();
    await bp.getByRole("button", { name: "채팅방 관리", exact: true }).click();
    const management = bp.getByRole("dialog", { name: "채팅방 관리", exact: true });
    await expect(
      management.getByRole("heading", { name: "방 준비 정보", exact: true }),
    ).toBeVisible();
    await expect(management).toContainText("참가자 간 AI 채팅");
    await expect(management.getByText("입력하지 않음", { exact: true })).toHaveCount(2);
    await bp.keyboard.press("Escape");
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
    await expect(ap.getByRole("heading", { name: "AI 채팅방 입장", exact: true })).toBeVisible();
    diagnostic.mark("test.logout-checked");
    await ap.goto(`/app/rooms/${scope.roomId}`);
    await expect(ap.getByRole("heading", { name: "AI 채팅방 입장", exact: true })).toBeVisible();
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
    const owner = await login(ap, `${info.project.name}-owner-revoke`, "소유자", diagnostic);
    diagnostic.mark("test.owner-ready");
    const scope = await createRoom(ap, diagnostic);
    diagnostic.mark("test.room-ready");
    const code = await issueInvite(ap, "observer", diagnostic);
    diagnostic.mark("test.invitation-ready");
    const observer = await login(bp, `${info.project.name}-observer`, "관찰자B", diagnostic);
    diagnostic.mark("test.observer-ready");
    await join(bp, code, diagnostic);
    diagnostic.mark("test.observer-joined");
    const memberCode = await issueInvite(ap, "participant", diagnostic);
    diagnostic.mark("test.invitation-ready");
    await login(memberPage, `${info.project.name}-non-owner-member`, "참여자C", diagnostic);
    diagnostic.mark("test.extra-member-ready");
    await join(memberPage, memberCode, diagnostic);
    diagnostic.mark("test.extra-member-joined");
    await bp.reload();
    const participantButton = bp.getByRole("button", { name: "참가자 정보 열기", exact: true });
    const sheetLayout = await participantButton.isVisible();
    const details = sheetLayout
      ? bp.getByRole("dialog", { name: "참가자와 AI", exact: true })
      : bp.getByRole("complementary", { name: "참가자 정보", exact: true });
    if (sheetLayout) await participantButton.click();
    await expect(details).toBeVisible();
    diagnostic.mark("test.observer-details-opened");
    await expect(details.getByText("참여자C · 참여자", { exact: true })).toBeVisible();
    diagnostic.mark("test.observer-details-checked");
    if (sheetLayout) {
      await bp.keyboard.press("Escape");
      await expect(details).toHaveCount(0);
      await expect(participantButton).toBeFocused();
    }
    diagnostic.mark("test.observer-details-closed");
    await expect(bp.getByText("내 역할:")).toContainText("관찰자");
    await bp.getByRole("button", { name: "채팅방 관리", exact: true }).click();
    const observerManagement = bp.getByRole("dialog", { name: "채팅방 관리", exact: true });
    await expect(observerManagement).toBeVisible();
    diagnostic.mark("test.observer-management-opened");
    await expect(observerManagement).toContainText("내 역할: 관찰자");
    await expect(
      observerManagement.getByRole("button", { name: "초대 발급", exact: true }),
    ).toHaveCount(0);
    await expect(observerManagement.getByRole("button", { name: /방에서 제거$/ })).toHaveCount(0);
    await expect(
      observerManagement.getByRole("button", { name: "참여자C 방에서 제거", exact: true }),
    ).toHaveCount(0);
    await bp.keyboard.press("Escape");
    await expect(observerManagement).toHaveCount(0);
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
    await ap.getByRole("button", { name: "채팅방 관리", exact: true }).click();
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
    await bp.getByRole("button", { name: "초대로 참가", exact: true }).click();
    const section = bp.getByRole("dialog", { name: "초대로 참가", exact: true });
    await section.getByLabel("초대 코드", { exact: true }).fill(code);
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

test("should clear rejected entry codes, recover with the owned identity and reconnect without a code", async ({
  browser,
}, info) => {
  const diagnostic = diagnostics("entry-recovery", info);
  const owned = await context(browser, info);
  try {
    const page = await owned.newPage();
    const person = await broker<BrowserPerson>("person", {
      label: `${info.project.name}-entry-recovery`,
    });
    const entry = await prepareTeamEntry(page, () =>
      broker<BrowserEntry>("code", { id: person.id }),
    );
    diagnostic.mark("test.entry-form-visible");
    await page.getByLabel("회사 입장 코드", { exact: true }).fill("invalid-company-code");
    await page.getByLabel("표시 이름", { exact: true }).fill("재접속 사용자");
    const rejected = diagnostic.wait(page, "test.entry-rejected-response");
    await page.getByRole("button", { name: "입장하기", exact: true }).click();
    const rejection = await rejected;
    requireCheck(rejection?.status() === 400, "Owned entry rejection status failed");
    const failure = await rejection.json();
    const codeRejected = failure.ok === false && failure.error?.code === "CODE_REJECTED";
    diagnostic.probe("test.entry-code-rejected", codeRejected);
    requireCheck(codeRejected, "Owned entry must reject the company code");
    await expect(page.getByLabel("회사 입장 코드", { exact: true })).toHaveValue("");
    diagnostic.mark("test.entry-code-cleared");
    await expect(page.getByLabel("표시 이름", { exact: true })).toHaveValue("재접속 사용자");
    diagnostic.mark("test.entry-name-retained");
    await expect(
      page.getByRole("alert").filter({ hasText: "회사 입장 코드를 확인하세요." }),
    ).toBeFocused();
    diagnostic.mark("test.entry-error-focused");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("회사 입장 코드", { exact: true })).toBeFocused();
    diagnostic.mark("test.entry-code-focused");
    await submitTeamEntry(page, person, entry, "재접속 사용자");
    diagnostic.mark("test.entry-retry-complete");
    let entries = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/auth/enter")) entries++;
    });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    requireCheck(entries === 0, "Owned reconnect unexpectedly submitted entry");
    diagnostic.mark("test.entry-reconnect-complete");
  } finally {
    diagnostic.finish();
    await owned.close();
  }
});

test("should retain an unauthenticated invitation destination and keep equal names as distinct owned users", async ({
  browser,
}, info) => {
  const a = await context(browser, info),
    b = await context(browser, info);
  const diagnostic = diagnostics("invited-room", info);
  try {
    const ownerPage = await a.newPage(),
      memberPage = await b.newPage();
    const owner = await login(
      ownerPage,
      `${info.project.name}-invite-entry-owner`,
      "같은 이름",
      diagnostic,
    );
    const scope = await createRoom(ownerPage, diagnostic);
    const code = await issueInvite(ownerPage, "participant", diagnostic);
    const member = await broker<BrowserPerson>("person", {
      label: `${info.project.name}-invite-entry-member`,
    });
    requireCheck(owner.id !== member.id, "Owned equal-name identities unexpectedly match");
    await enterTeam(
      memberPage,
      member,
      () => broker<BrowserEntry>("code", { id: member.id }),
      "같은 이름",
      `/app?invite=${code}`,
    );
    const dialog = memberPage.getByRole("dialog", { name: "초대로 참가", exact: true });
    await expect(dialog.getByLabel("초대 코드", { exact: true })).toHaveValue(code);
    await dialog.getByRole("button", { name: "방 참가", exact: true }).click();
    await expect(
      memberPage.getByRole("heading", { name: "초대된 조사방", exact: true }),
    ).toBeVisible();
    requireCheck(
      !new URL(memberPage.url()).searchParams.has("invite"),
      "Owned invite remained after joining",
    );
    await memberPage.reload();
    requireCheck(
      new URL(memberPage.url()).pathname === `/app/rooms/${scope.roomId}`,
      "Owned invitation room changed",
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
    diagnostic.finish();
  }
});

test("should create a fresh browser identity without cookies and promptly claim its session and room for cleanup", async ({
  browser,
}, info) => {
  const owned = await context(browser, info);
  try {
    const reservation = await broker<{ reservationId: string; displayName: string; code: string }>(
      "fresh-entry",
      {},
    );
    const page = await owned.newPage();
    requireCheck((await owned.cookies()).length === 0, "Fresh entry context must be empty");
    await page.goto("/login");
    await page.getByLabel("회사 입장 코드", { exact: true }).fill(reservation.code);
    await page.getByLabel("표시 이름", { exact: true }).fill(reservation.displayName);
    const entered = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/auth/enter"),
    );
    // Claim ownership before any navigation or UI assertion can fail.
    const clicked = page
      .getByRole("button", { name: "입장하기", exact: true })
      .click()
      .then(
        () => true,
        () => false,
      );
    const { userId, cookies } = await claimFreshResponse(owned, await entered, reservation);
    requireCheck(await clicked, "Fresh entry UI action failed after cleanup claim");
    requireCheck(
      cookies.length > 0 && cookies.every((cookie) => cookie.httpOnly && cookie.sameSite === "Lax"),
      "Fresh entry requires an HttpOnly session",
    );
    await expect(page.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    let entries = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/auth/enter")) entries++;
    });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    requireCheck(entries === 0, "Fresh identity reconnect must not submit entry again");
    await page.getByRole("button", { name: "새 채팅방", exact: true }).click();
    const create = page.getByRole("dialog", { name: "새 채팅방", exact: true });
    await create.getByLabel("방 이름", { exact: true }).fill("새 브라우저의 채팅방");
    const created = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/access/bootstrap"),
    );
    const createClicked = create
      .getByRole("button", { name: "방 만들기", exact: true })
      .click()
      .then(
        () => true,
        () => false,
      );
    const bootstrap = await created;
    const scope = await bootstrap.json();
    requireCheck(
      bootstrap.status() === 200 && scope.ok && typeof scope.data?.organizationId === "string",
      "Fresh owned room response failed",
    );
    await broker("track", { organizationId: scope.data.organizationId });
    requireCheck(await createClicked, "Fresh room UI action failed after cleanup track");
    await expect(
      page.getByRole("heading", { name: "새 브라우저의 채팅방", exact: true }),
    ).toBeVisible();
    const selfRemoval = await page.request.post("/api/access/revoke-room-member", {
      headers: { Origin: process.env.APP_ORIGIN! },
      data: { roomId: scope.data.roomId, userId },
    });
    requireCheck(selfRemoval.status() === 403, "Fresh real owner self-removal must be forbidden");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "새 브라우저의 채팅방", exact: true }),
    ).toBeVisible();
    requireCheck(entries === 0, "Fresh room access must preserve the admitted identity");
  } finally {
    await owned.close();
  }
});

test("should preserve a deleted provider identity until deliberate logout and claim only the subsequent fresh identity", async ({
  browser,
}, info) => {
  const owned = await context(browser, info);
  try {
    const previous = await broker<BrowserPerson>("person", {
      label: `${info.project.name}-deleted-provider`,
    });
    const page = await owned.newPage();
    const entry = await prepareTeamEntry(page, () =>
      broker<BrowserEntry>("code", { id: previous.id }),
    );
    const originalCookies = (await owned.cookies()).filter((cookie) =>
      /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name),
    );
    requireCheck(originalCookies.length > 0, "Deleted identity requires an actual owned session");
    await broker("delete-person", { id: previous.id });
    const actions: ("enter" | "logout")[] = [];
    const actionCount = (kind: "enter" | "logout") =>
      actions.filter((action) => action === kind).length;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url().endsWith("/api/auth/enter")) actions.push("enter");
      if (request.url().endsWith("/api/auth/logout")) actions.push("logout");
    });
    await page.getByLabel("회사 입장 코드", { exact: true }).fill(entry.code);
    await page.getByLabel("표시 이름", { exact: true }).fill("폐기된 세션 사용자");
    const rejected = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/auth/enter"),
    );
    await page.getByRole("button", { name: "입장하기", exact: true }).click();
    const rejection = await rejected;
    const body = await rejection.json();
    requireCheck(
      rejection.status() === 401 && body.ok === false && body.error?.code === "UNAUTHENTICATED",
      "Actual deleted provider identity must be rejected",
    );
    const reset = page.getByRole("button", { name: "로그아웃하고 새 입장 준비", exact: true });
    await expect(reset).toBeVisible();
    await expect(
      page.getByText("이전 사용자와 AI 소유권은 같은 표시 이름으로 복구할 수 없습니다.", {
        exact: false,
      }),
    ).toBeVisible();
    const retained = (await owned.cookies()).filter((cookie) =>
      /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name),
    );
    requireCheck(
      JSON.stringify(retained.map(({ name, value }) => ({ name, value }))) ===
        JSON.stringify(originalCookies.map(({ name, value }) => ({ name, value }))),
      "Rejected actual identity cookies must remain until chosen logout",
    );
    requireCheck(
      actionCount("enter") === 1 && actionCount("logout") === 0,
      "Rejection must not automatically reset or enter again",
    );
    const loggedOut = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/auth/logout"),
    );
    await reset.click();
    requireCheck(
      (await loggedOut).status() === 200,
      "Explicit deleted-session logout must succeed",
    );
    await expect(reset).toHaveCount(0);
    requireCheck(
      !(await owned.cookies()).some((cookie) =>
        /^sb-.+-auth-token(?:-code-verifier)?(?:\.\d+)?$/.test(cookie.name),
      ),
      "Explicit logout must clear the complete session cookie family",
    );
    requireCheck(
      actionCount("enter") === 1 && actionCount("logout") === 1,
      "Logout must not implicitly submit another entry",
    );
    const reservation = await broker<BrowserReservation>("fresh-entry", {});
    await page.getByLabel("회사 입장 코드", { exact: true }).fill(reservation.code);
    await page.getByLabel("표시 이름", { exact: true }).fill(reservation.displayName);
    const entered = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/auth/enter"),
    );
    const clicked = page
      .getByRole("button", { name: "입장하기", exact: true })
      .click()
      .then(
        () => true,
        () => false,
      );
    const current = await claimFreshResponse(owned, await entered, reservation);
    requireCheck(
      current.userId !== previous.id && (await clicked),
      "Deliberate fresh entry must have a separately claimed identity",
    );
    await expect(page.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
    requireCheck(
      actionCount("enter") === 2 && actionCount("logout") === 1,
      "Only the two explicit entry actions may be submitted",
    );
  } finally {
    await owned.close();
  }
});

test("should open room creation from mobile navigation and return focus after cancelling", async ({
  browser,
}, info) => {
  const diagnostic = diagnostics("mobile-room-create", info);
  const owned = await context(browser, info);
  try {
    const page = await owned.newPage();
    await login(
      page,
      `${info.project.name}-mobile-navigation-create`,
      "메뉴 생성 사용자",
      diagnostic,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const menu = page.getByRole("button", { name: "채팅방 목록 열기", exact: true });
    await menu.click();
    const navigation = page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true });
    await expect(navigation).toBeVisible();
    diagnostic.mark("test.mobile-create-navigation-opened");
    await navigation.getByRole("button", { name: "새 채팅방", exact: true }).click();
    diagnostic.mark("test.mobile-create-triggered");
    const creation = page.getByRole("dialog", { name: "새 채팅방", exact: true });
    await expect(creation).toBeVisible();
    await expect(navigation).toHaveCount(0);
    await expect(creation.getByLabel("방 이름", { exact: true })).toBeFocused();
    diagnostic.mark("test.mobile-create-dialog-visible");
    await page.keyboard.press("Escape");
    await expect(creation).toHaveCount(0);
    await expect(menu).toBeFocused();
    diagnostic.mark("test.mobile-create-focus-restored");
  } finally {
    diagnostic.finish();
    await owned.close();
  }
});

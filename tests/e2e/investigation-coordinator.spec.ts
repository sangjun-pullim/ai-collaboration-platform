import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
test.afterEach(({ browserName }, info) => {
  void browserName;
  if (!info.errors.length) return;
  // Emit only source coordinates. Never expose the error, locator or fixture data.
  const frames = info.errors.flatMap((error) =>
    [...(error.stack ?? "").matchAll(/investigation-coordinator\.spec\.ts:(\d+):(\d+)/g)]
      .slice(0, 4)
      .map((match) => ({ line: Number(match[1]), column: Number(match[2]) })),
  );
  console.log(
    JSON.stringify({
      source: "workflow-browser",
      mobile: info.project.name.includes("mobile"),
      frames,
    }),
  );
});
installAuthArtifactPolicy(test);
import {
  enterTeam,
  clearAuthCookies,
  type BrowserEntry,
  type BrowserPerson,
} from "../helpers/browser-team-entry.js";
function check(v: unknown): asserts v {
  if (!v) throw new Error("Owned workflow browser assertion failed");
}
async function broker<T>(action: string, body: unknown): Promise<T> {
  const endpoint = process.env.LOCAL_WORKFLOW_FIXTURE_URL,
    token = process.env.LOCAL_WORKFLOW_FIXTURE_TOKEN;
  check(endpoint && token && new URL(endpoint).hostname === "127.0.0.1");
  const r = await fetch(`${endpoint}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  check(r.ok);
  return r.json() as Promise<T>;
}
async function context(browser: Browser, info: TestInfo) {
  return browser.newContext({
    baseURL: process.env.APP_ORIGIN,
    viewport: info.project.use.viewport,
    isMobile: info.project.use.isMobile,
    hasTouch: info.project.use.hasTouch,
  });
}
async function login(page: Page, person: BrowserPerson) {
  await enterTeam(page, person, () => broker<BrowserEntry>("code", { id: person.id }));
}

function sceneName(info: TestInfo, kind: "history" | "control" | "input-pause") {
  return `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-${kind}`;
}
test("should display an owned investigation and restore public history for an observer", async ({
  browser,
}, info) => {
  const a = await context(browser, info),
    b = await context(browser, info);
  try {
    const scene = sceneName(info, "history");
    const data = await broker<{
      roomId: string;
      owner: BrowserPerson;
      observer: BrowserPerson;
    }>("setup", { scene });
    const ap = await a.newPage(),
      bp = await b.newPage();
    await login(ap, data.owner);
    await login(bp, data.observer);
    await ap.goto(`/app/rooms/${data.roomId}`);
    await bp.goto(`/app/rooms/${data.roomId}`);
    const own = ap.getByRole("region", { name: "실제 공동 조사" }),
      observed = bp.getByRole("region", { name: "실제 공동 조사" });
    await own.getByLabel("보낼 곳", { exact: true }).selectOption("speak");
    await expect(own.getByRole("button", { name: "공동 발언 저장", exact: true })).toBeVisible();
    await own.getByRole("button", { name: "공동 조사", exact: true }).click();
    const advanced = ap.getByRole("dialog", { name: "공동 조사", exact: true });
    await expect(observed.getByRole("button", { name: "공동 발언 저장", exact: true })).toHaveCount(
      0,
    );
    for (const label of ["내 AI", "상대 AI"]) {
      const selector = advanced.getByLabel(label);
      const option = selector.locator("option").filter({ hasText: "공개 저장소" });
      await expect(option).toHaveCount(1);
      await expect(option).toContainText("codex");
      await expect(option).toContainText("공개 세션");
      const value = await option.getAttribute("value");
      check(value);
      await selector.selectOption(value);
      await expect(selector).toHaveValue(value);
    }
    await ap.keyboard.press("Escape");
    await own.getByLabel("공동 발언", { exact: true }).fill("브라우저 공개 발언");
    await own.getByRole("button", { name: "공동 발언 저장", exact: true }).click();
    await expect(own.getByLabel("확정 공동 이력")).toContainText("브라우저 공개 발언");
    await broker("drive", { scene, step: "history" });
    await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 질문", {
      timeout: 45000,
    });
    await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 결과");
    await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 origin 결과");
    await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 최종 결과");
    await bp.reload();
    await expect(observed.getByLabel("확정 공동 이력")).toContainText("브라우저 공개 발언");
    await expect(observed.getByText("현재 조사 채택", { exact: true }).first()).toBeVisible();
    check(
      !(
        (await bp.content()).includes("private-native-") ||
        (await bp.content()).includes("credentialHash")
      ),
    );
    check(await bp.locator("body").evaluate((el) => el.scrollWidth <= innerWidth + 1));
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
test("should distinguish reported execution unknown and confirmed pause in the browser", async ({
  browser,
}, info) => {
  const a = await context(browser, info);
  try {
    const scene = sceneName(info, "control");
    const data = await broker<{ roomId: string; owner: BrowserPerson }>("setup", {
      scene,
    });
    const page = await a.newPage();
    await login(page, data.owner);
    await page.goto(`/app/rooms/${data.roomId}`);
    const region = page.getByRole("region", { name: "실제 공동 조사" });
    await expect(region.getByLabel("보낼 곳")).toHaveValue("ask");
    await broker("drive", { scene, step: "start" });
    await expect(region.getByLabel("공개 실행 보고")).toContainText("실행 보고 · provider 미검증", {
      timeout: 45000,
    });
    await region.getByRole("button", { name: "공동 조사", exact: true }).click();
    const advanced = page.getByRole("dialog", { name: "공동 조사", exact: true });
    const pause = advanced.getByRole("button", { name: "방 일시정지 요청", exact: true });
    await pause.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(region.getByRole("status", { name: "방 상태", exact: true })).toContainText(
      "중단 확인 대기",
    );
    await broker("drive", { scene, step: "ack" });
    await expect(region.getByRole("status", { name: "방 상태", exact: true })).toContainText(
      "중단 확인 대기",
    );
    await broker("drive", { scene, step: "unknown" });
    await expect(region.getByLabel("공개 실행 보고")).toContainText(
      "종결 미확인 · 사람 확인 필요",
      { timeout: 45000 },
    );
    await region.getByRole("button", { name: "공동 조사", exact: true }).click();
    const resume = advanced.getByRole("button", { name: "방 발언·조사 접수 재개", exact: true });
    await expect(resume).toBeDisabled();
    await page.keyboard.press("Escape");
    await broker("drive", { scene, step: "terminal" });
    await expect(region.getByRole("status", { name: "방 상태", exact: true })).toContainText(
      "일시정지 확인",
      { timeout: 45000 },
    );
    await region.getByRole("button", { name: "공동 조사", exact: true }).click();
    await expect(resume).toBeEnabled();
    await resume.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(region.getByRole("status", { name: "방 상태", exact: true })).toContainText(
      "활성",
    );
    await region.getByLabel("보낼 곳").selectOption("speak");
    await region.getByLabel("공동 발언", { exact: true }).fill(" ");
    await expect(
      region.getByRole("button", { name: "공동 발언 저장", exact: true }),
    ).toBeDisabled();
    check(!(await page.content()).includes("private-native-"));
    check(await page.locator("body").evaluate((el) => el.scrollWidth <= innerWidth + 1));
  } finally {
    await a.close();
  }
});

test("should show a direct question form without an own AI connection", async ({
  browser,
}, info) => {
  // Idle/hidden polling takes 10/30 seconds; wait up to 45 seconds for external changes.
  const pollingWait = { timeout: 45_000 };
  for (const variant of ["single", "multiple"]) {
    // Emit literal stages only; never include identity, DOM, request or error values.
    if (variant === "single") process.stdout.write("010_DIRECT_STAGE SINGLE_BEGIN\n");
    else process.stdout.write("010_DIRECT_STAGE MULTIPLE_BEGIN\n");
    const own = await context(browser, info),
      observed = await context(browser, info);
    try {
      const scene = `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-direct-${variant}`;
      process.stdout.write("010_DIRECT_STAGE SETUP_BEFORE\n");
      const data = await broker<{
        roomId: string;
        targetAgentIds: string[];
        requester: BrowserPerson;
        observer: BrowserPerson;
      }>("setup", { scene });
      process.stdout.write("010_DIRECT_STAGE SETUP_AFTER\n");
      const page = await own.newPage(),
        observer = await observed.newPage();
      process.stdout.write("010_DIRECT_STAGE REQUESTER_LOGIN_BEFORE\n");
      await login(page, data.requester);
      process.stdout.write("010_DIRECT_STAGE OBSERVER_LOGIN_BEFORE\n");
      await login(observer, data.observer);
      process.stdout.write("010_DIRECT_STAGE READY_BEFORE\n");
      await broker("direct-drive", { scene, step: "ready" });
      process.stdout.write("010_DIRECT_STAGE READY_AFTER\n");
      await page.goto(`/app/rooms/${data.roomId}`);
      await observer.goto(`/app/rooms/${data.roomId}`);
      process.stdout.write("010_DIRECT_STAGE ROOM_LOADED\n");
      const region = page.getByRole("region", { name: "실제 공동 조사" });
      const form = region.getByRole("form", { name: "상대 AI에 직접 질문" });
      const target = form.getByLabel("직접 질문 대상", { exact: true });
      const send = form.getByRole("button", { name: "상대 AI에 질문 보내기", exact: true });
      process.stdout.write("010_DIRECT_STAGE FORM_VISIBLE_BEFORE\n");
      await expect(form).toBeVisible();
      process.stdout.write("010_DIRECT_STAGE OBSERVER_READ_ONLY_BEFORE\n");
      await expect(observer.getByRole("form", { name: "상대 AI에 직접 질문" })).toHaveCount(0);
      process.stdout.write("010_DIRECT_STAGE OWN_AI_DISABLED_BEFORE\n");
      await region.getByRole("button", { name: "공동 조사", exact: true }).click();
      await expect(
        page
          .getByRole("dialog", { name: "공동 조사", exact: true })
          .getByRole("button", { name: "조사 시작", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      if (variant === "single") {
        process.stdout.write("010_DIRECT_STAGE SINGLE_TARGET_BEFORE\n");
        await expect(target).toHaveValue(data.targetAgentIds[0]);
        process.stdout.write("010_DIRECT_STAGE SINGLE_TARGET_AFTER\n");
        await expect(form).toContainText("codex");
        process.stdout.write("010_DIRECT_STAGE SINGLE_DESCRIPTION_AFTER\n");
      } else {
        process.stdout.write("010_DIRECT_STAGE MULTIPLE_SELECTION_BEFORE\n");
        await expect(target).toHaveValue("");
        await expect(send).toBeDisabled();
        await target.selectOption(data.targetAgentIds[0]);
        process.stdout.write("010_DIRECT_STAGE REPLACE_BEFORE\n");
        await broker("direct-drive", { scene, step: "replace" });
        process.stdout.write("010_DIRECT_STAGE REPLACE_DISABLED_BEFORE\n");
        await expect(send).toBeDisabled(pollingWait);
        await expect(target).toContainText("기존 대상 변경", pollingWait);
        process.stdout.write("010_DIRECT_STAGE REPLACE_RESELECT_BEFORE\n");
        await target.selectOption(data.targetAgentIds[0]);
        await expect(form).toContainText("새 직접 세션", pollingWait);
        process.stdout.write("010_DIRECT_STAGE OFFLINE_BEFORE\n");
        await broker("direct-drive", { scene, step: "offline" });
        await expect(send).toBeDisabled(pollingWait);
        await target.selectOption(data.targetAgentIds[1]);
        process.stdout.write("010_DIRECT_STAGE MULTIPLE_SELECTION_AFTER\n");
      }
      if (variant === "single") {
        await region.getByLabel("보낼 곳", { exact: true }).selectOption("speak");
        const input = region.getByLabel("공동 발언", { exact: true });
        for (let index = 0; index < 3; index++) {
          await input.fill(
            `스크롤 회귀용 공개 발언 ${index}\n` +
              "읽고 있던 기록의 위치를 유지합니다.\n".repeat(30),
          );
          await region.getByRole("button", { name: "공동 발언 저장", exact: true }).click();
          await expect(input).toHaveValue("");
          await expect(input).toBeFocused();
        }
        await expect(region.getByLabel("확정 공동 이력")).toContainText(
          "스크롤 회귀용 공개 발언 2",
        );
        await region.getByLabel("보낼 곳", { exact: true }).selectOption("ask");
        const scroll = region.getByLabel("대화 기록 스크롤", { exact: true });
        await scroll.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        check(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight));
      }
      process.stdout.write("010_DIRECT_STAGE FORM_INPUT_BEFORE\n");
      await form
        .getByLabel("상대에게 보낼 질문", { exact: true })
        .fill("한국어 키보드 직접 질문 😀");
      await expect(send).toBeEnabled();
      process.stdout.write("010_DIRECT_STAGE FORM_READY\n");
      const questionInput = form.getByLabel("상대에게 보낼 질문", { exact: true });
      await questionInput.dispatchEvent("compositionstart");
      await questionInput.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        isComposing: true,
        keyCode: 229,
      });
      await questionInput.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        isComposing: false,
        keyCode: 13,
      });
      await expect(region.getByLabel("확정 공동 이력")).not.toContainText(
        "한국어 키보드 직접 질문 😀",
      );
      await expect(questionInput).toHaveValue("한국어 키보드 직접 질문 😀");
      await questionInput.dispatchEvent("compositionend");
      await questionInput.press("Shift+Enter");
      await expect(questionInput).toHaveValue("한국어 키보드 직접 질문 😀\n");
      await questionInput.fill("한국어 키보드 직접 질문 😀");
      await page.getByRole("button", { name: "채팅방 관리", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "채팅방 관리", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "채팅방 관리", exact: true })).toBeFocused();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 844 });
        check(
          await page.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1),
        );
        await expect(questionInput).toHaveValue("한국어 키보드 직접 질문 😀");
        if (width < 1280) {
          const participants = page.getByRole("button", { name: "참가자 정보 열기", exact: true });
          await participants.click();
          await expect(
            page.getByRole("dialog", { name: "참가자와 AI", exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(participants).toBeFocused();
        }
        if (width < 1024) {
          const menu = page.getByRole("button", { name: "채팅방 목록 열기", exact: true });
          await menu.click();
          await expect(
            page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(menu).toBeFocused();
        }
      }
      await page.setViewportSize(info.project.use.viewport!);

      const bodies: unknown[] = [];
      if (variant === "single") {
        let lost = false;
        await page.route("**/api/investigations/ask", async (route) => {
          bodies.push(route.request().postDataJSON());
          const response = await route.fetch();
          if (!lost) {
            lost = true;
            await route.abort("failed");
          } else await route.fulfill({ response });
        });
      }
      process.stdout.write("010_DIRECT_STAGE SEND_BEFORE\n");
      await send.focus();
      await page.keyboard.press("Enter");
      process.stdout.write("010_DIRECT_STAGE QUESTION_HISTORY_BEFORE\n");
      await expect(region.getByLabel("확정 공동 이력")).toContainText(
        "한국어 키보드 직접 질문 😀",
        { timeout: 45000 },
      );
      process.stdout.write("010_DIRECT_STAGE QUESTION_HISTORY_AFTER\n");
      const questionRecord = region
        .getByLabel("확정 공동 이력")
        .getByRole("listitem")
        .filter({ hasText: "한국어 키보드 직접 질문 😀" })
        .first();
      await expect(questionRecord).toContainText("저장된 대상:");
      await expect(questionRecord).toContainText(
        "당시 대상은 저장되어 있으나 파일 관찰 자료는 없습니다.",
      );
      if (variant === "single") {
        await expect(
          region.getByRole("button", { name: "새 메시지 · 아래로 이동", exact: true }),
        ).toBeVisible();
        check(
          await region
            .getByLabel("대화 기록 스크롤", { exact: true })
            .evaluate((element) => element.scrollTop === 0),
        );
        await region.getByRole("button", { name: "새 메시지 · 아래로 이동", exact: true }).click();
      }
      if (variant === "single") {
        process.stdout.write("010_DIRECT_STAGE RECOVERY_VISIBLE_BEFORE\n");
        await expect(
          region.getByRole("button", { name: "같은 요청 확인", exact: true }),
        ).toBeVisible();
        await page.reload();
        process.stdout.write("010_DIRECT_STAGE RECOVERY_REPLAY_BEFORE\n");
        await region.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(
          region.getByRole("button", { name: "같은 요청 확인", exact: true }),
        ).toHaveCount(0);
        check(bodies.length === 2 && JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]));
        process.stdout.write("010_DIRECT_STAGE RECOVERY_REPLAY_AFTER\n");
        const result = await broker<{ requests: number }>("direct-drive", {
          scene,
          step: "answer",
        });
        check(result.requests === 1);
        process.stdout.write("010_DIRECT_STAGE ANSWER_REQUESTER_BEFORE\n");
        await expect(region.getByLabel("확정 공동 이력")).toContainText(
          "한글 직접 답변",
          pollingWait,
        );
        process.stdout.write("010_DIRECT_STAGE ANSWER_OBSERVER_BEFORE\n");
        await expect(observer.getByLabel("확정 공동 이력")).toContainText(
          "한글 직접 답변",
          pollingWait,
        );
        await page.reload();
        process.stdout.write("010_DIRECT_STAGE ANSWER_RELOAD_BEFORE\n");
        await expect(region.getByLabel("직접 질문 상태")).toContainText("완료 보고", pollingWait);
        await expect(
          region.getByRole("button", { name: "이 직접 질문 중단 요청", exact: true }),
        ).toHaveCount(0);
        process.stdout.write("010_DIRECT_STAGE ANSWER_AFTER\n");
      } else {
        process.stdout.write("010_DIRECT_STAGE ACTIVE_START_BEFORE\n");
        await broker("direct-drive", { scene, step: "start" });
        await expect(region.getByLabel("직접 질문 상태")).toContainText("실행 보고", {
          timeout: 45000,
        });
        process.stdout.write("010_DIRECT_STAGE CANCEL_BEFORE\n");
        const stop = region.getByRole("button", { name: "이 직접 질문 중단 요청", exact: true });
        await stop.focus();
        await page.keyboard.press("Enter");
        await expect(
          region
            .getByRole("status", { name: "방 상태", exact: true })
            .filter({ hasText: "조사: 사람 확인 필요" }),
        ).toBeVisible(pollingWait);
        process.stdout.write("010_DIRECT_STAGE CANCEL_ACK_BEFORE\n");
        await broker("direct-drive", { scene, step: "ack" });
        await expect(region.getByLabel("직접 질문 상태")).toContainText("실행 보고", pollingWait);
        await expect(send).toBeDisabled(pollingWait);
        process.stdout.write("010_DIRECT_STAGE CANCEL_TERMINAL_BEFORE\n");
        await broker("direct-drive", { scene, step: "terminal" });
        await expect(region.getByLabel("직접 질문 상태")).toContainText(
          "중단 확인 보고",
          pollingWait,
        );
        process.stdout.write("010_DIRECT_STAGE CANCEL_AFTER\n");
      }
      process.stdout.write("010_DIRECT_STAGE PRIVACY_LAYOUT_BEFORE\n");
      check(!(await page.content()).includes("private-native-"));
      check(
        await page.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1),
      );
      process.stdout.write("010_DIRECT_STAGE VARIANT_AFTER\n");
    } finally {
      process.stdout.write("010_DIRECT_STAGE CLEANUP_BEFORE\n");
      await Promise.all([own.close(), observed.close()]);
      process.stdout.write("010_DIRECT_STAGE CLEANUP_AFTER\n");
    }
  }
});

test("should isolate unresolved direct intents across authenticated users", async ({
  browser,
}, info) => {
  for (const mode of ["actor", "cookie"] as const) {
    const owned = await context(browser, info);
    try {
      const scene = `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-direct-${mode}`;
      const data = await broker<{
        roomId: string;
        requester: BrowserPerson;
        actorB: BrowserPerson;
      }>("setup", { scene });
      const page = await owned.newPage();
      await login(page, data.requester);
      await broker("direct-drive", { scene, step: "ready" });
      await page.goto(`/app/rooms/${data.roomId}`);
      let first = true;
      let staleStatus = 0;
      let transmissions = 0;
      await page.route("**/api/investigations/ask", async (route) => {
        transmissions++;
        const response = await route.fetch();
        if (first) {
          first = false;
          await route.abort("failed");
        } else {
          staleStatus = response.status();
          await route.fulfill({ response });
        }
      });
      const region = page.getByRole("region", { name: "실제 공동 조사" });
      const form = region.getByRole("form", { name: "상대 AI에 직접 질문" });
      await form
        .getByLabel("상대에게 보낼 질문", { exact: true })
        .fill("계정 전환의 확정된 첫 질문");
      await form.getByRole("button", { name: "상대 AI에 질문 보내기", exact: true }).click();
      await expect(
        region.getByRole("button", { name: "같은 요청 확인", exact: true }),
      ).toBeVisible();
      await broker("direct-drive", { scene, step: "answer" });
      await expect(region.getByLabel("직접 질문 상태")).toContainText("완료 보고", {
        timeout: 45_000,
      });
      if (mode === "actor") {
        await page.getByRole("button", { name: "로그아웃", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "AI 채팅방 입장", exact: true }),
        ).toBeVisible();
        await login(page, data.actorB);
        await page.goto(`/app/rooms/${data.roomId}`);
        await expect(region.getByRole("form", { name: "상대 AI에 직접 질문" })).toBeVisible();
        await expect(region.getByLabel("직접 질문 상태")).toContainText("완료 보고", {
          timeout: 45_000,
        });
        await expect(
          region.getByRole("button", { name: "같은 요청 확인", exact: true }),
        ).toHaveCount(0);
        check(transmissions === 1);
      } else {
        // Verify B independently, then replace shared cookies while A stays mounted.
        const replacement = await context(browser, info);
        try {
          const replacementPage = await replacement.newPage();
          await login(replacementPage, data.actorB);
          const cookies = await replacement.cookies();
          await clearAuthCookies(owned);
          await owned.addCookies(cookies);
          const cookiePage = await owned.newPage();
          await cookiePage.goto("/login");
          await expect(
            cookiePage.getByRole("heading", { name: "내 AI 채팅방", exact: true }),
          ).toBeVisible();
        } finally {
          await replacement.close();
        }
        await page.bringToFront();
        await region.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(region.getByRole("alert", { name: "조사 오류", exact: true })).toBeVisible({
          timeout: 45_000,
        });
        check(transmissions === 2 && staleStatus === 403);
        await expect(region.getByRole("form", { name: "상대 AI에 직접 질문" })).toHaveCount(0);
      }
      const result = await broker<{ state: string; requests: number; controls: number }>(
        "direct-drive",
        { scene, step: "actor-check" },
      );
      check(result.state === "COMPLETED" && result.requests === 1 && result.controls === 0);
    } finally {
      await owned.close();
    }
  }
});

test("should retain saved direct identity through completed replacement and detach while preserving chat input and reading position", async ({
  browser,
}, info) => {
  const owned = await context(browser, info);
  try {
    const scene = `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-direct-history`;
    const data = await broker<{
      roomId: string;
      targetAgentIds: string[];
      requester: BrowserPerson;
    }>("setup", { scene });
    const page = await owned.newPage();
    await login(page, data.requester);
    await broker("direct-drive", { scene, step: "ready" });
    await page.setViewportSize({ width: 768, height: 844 });
    await page.goto(`/app/rooms/${data.roomId}`);
    const region = page.getByRole("region", { name: "실제 공동 조사" });
    const list = region.getByLabel("확정 공동 이력", { exact: true });
    const scroll = region.getByLabel("대화 기록 스크롤", { exact: true });
    const mode = region.getByLabel("보낼 곳", { exact: true });
    await mode.selectOption("speak");
    const speech = region.getByLabel("공동 발언", { exact: true });
    for (let index = 0; index < 3; index++) {
      await speech.fill(
        `완료 이력의 앞선 발언 ${index}\n` + "읽고 있던 긴 기록입니다.\n".repeat(30),
      );
      await region.getByRole("button", { name: "공동 발언 저장", exact: true }).click();
      await expect(speech).toHaveValue("");
      await expect(speech).toBeFocused();
    }
    await expect(list).toContainText("완료 이력의 앞선 발언 2");
    await mode.selectOption("ask");
    const form = region.getByRole("form", { name: "상대 AI에 직접 질문" });
    const input = form.getByLabel("상대에게 보낼 질문", { exact: true });
    const target = form.getByLabel("직접 질문 대상", { exact: true });
    const send = form.getByRole("button", { name: "상대 AI에 질문 보내기", exact: true });
    await expect(target).toHaveValue(data.targetAgentIds[0]);
    await expect(form.getByRole("checkbox")).toHaveCount(0);
    await expect(form).toContainText("질문과 답변은 채팅방 참가자에게 공유됩니다.");
    let transmissions = 0;
    const askCount = () => transmissions;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/investigations/ask"))
        transmissions++;
    });
    await input.fill("저장된 연결의 한 번 질문");
    await input.focus();
    await input.dispatchEvent("compositionstart");
    await input.press("Enter");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      bubbles: true,
      keyCode: 229,
    });
    await expect(input).toHaveValue(/저장된 연결의 한 번 질문/);
    check(askCount() === 0);
    await input.dispatchEvent("compositionend");
    await input.fill("저장된 연결의 한 번 질문");
    await input.press("End");
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("저장된 연결의 한 번 질문\n");
    check(askCount() === 0);
    await input.fill("저장된 연결의 한 번 질문");
    const asked = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/investigations/ask"),
    );
    await input.press("Enter");
    check((await asked).status() === 200 && askCount() === 1);
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(list).toContainText("저장된 연결의 한 번 질문");
    const question = list
      .getByRole("listitem")
      .filter({ has: page.getByText("질문", { exact: true }) });
    const sourceResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/investigations/source-read"),
    );
    await question.getByRole("button", { name: "저장소·자료", exact: true }).click();
    const sourceEnvelope = await (await sourceResponse).json();
    const storedTarget = sourceEnvelope.data?.target;
    check(
      sourceEnvelope.ok &&
        storedTarget?.agentId === data.targetAgentIds[0] &&
        storedTarget.bindingEpoch > 0,
    );
    const epoch = storedTarget.bindingEpoch;
    await expect(question).toContainText("당시 대상은 저장되어 있으나 파일 관찰 자료는 없습니다.");

    const draft = "답변을 읽으며 쓰는 다음 질문";
    await input.fill(draft);
    await input.focus();
    await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(2, 8));
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    check(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight));
    const answered = await broker<{ requests: number }>("direct-drive", { scene, step: "answer" });
    check(answered.requests === 1);
    await expect(list).toContainText("한글 직접 답변", { timeout: 45_000 });
    await expect(input).toHaveValue(draft);
    await expect(input).toBeFocused();
    await expect(target).toHaveValue(data.targetAgentIds[0]);
    check(
      await input.evaluate(
        (element) =>
          (element as HTMLTextAreaElement).selectionStart === 2 &&
          (element as HTMLTextAreaElement).selectionEnd === 8,
      ),
    );
    check(await scroll.evaluate((element) => element.scrollTop === 0));
    const unread = region.getByRole("button", { name: "새 메시지 · 아래로 이동", exact: true });
    await expect(unread).toBeVisible();
    await unread.click();
    await expect(unread).toHaveCount(0);
    check(
      await scroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 64,
      ),
    );
    check(askCount() === 1);

    async function savedHistory() {
      const records = list.getByRole("listitem").filter({ has: page.getByText(/^(질문|답변)$/) });
      await expect(records.filter({ has: page.getByText(/^(질문|답변)$/) })).toHaveCount(2);
      for (const record of await records.all()) {
        const detail = record.getByRole("button", { name: "저장소·자료", exact: true });
        if (await detail.count()) {
          const response = page.waitForResponse(
            (value) =>
              value.request().method() === "POST" &&
              value.url().endsWith("/api/investigations/source-read"),
          );
          await detail.click();
          const source = await (await response).json();
          check(
            source.ok &&
              source.data?.target?.agentId === data.targetAgentIds[0] &&
              source.data.target.bindingEpoch === epoch,
          );
        }
        await expect(record).toContainText(storedTarget.ownerAlias);
        await expect(record).toContainText(storedTarget.repositoryAlias);
        await expect(record).toContainText(storedTarget.sessionAlias);
        await expect(record).toContainText("현재 같은 연결 없음");
        await expect(record).toContainText(
          "당시 대상은 저장되어 있으나 파일 관찰 자료는 없습니다.",
        );
        await expect(record).not.toContainText("완료 뒤 새 저장소");
      }
      await expect(
        list.getByRole("listitem").filter({ has: page.getByText("답변", { exact: true }) }),
      ).toHaveCount(1);
      check(askCount() === 1);
    }
    await broker("direct-drive", { scene, step: "replace-completed" });
    await expect(target).toContainText("완료 뒤 새 저장소", { timeout: 45_000 });
    await expect(target).toContainText("기존 대상 변경");
    await expect(send).toBeDisabled();
    await savedHistory();
    await target.selectOption(data.targetAgentIds[0]);
    await expect(form).toContainText("완료 뒤 새 저장소");
    await page.reload();
    await expect(form).toContainText("완료 뒤 새 저장소", { timeout: 45_000 });
    await savedHistory();
    await broker("direct-drive", { scene, step: "detach-completed" });
    await expect(form).toContainText("준비 보고가 유효한 상대가 없습니다", { timeout: 45_000 });
    await expect(form).not.toContainText("완료 뒤 새 저장소");
    await savedHistory();
    await page.reload();
    await expect(form).toContainText("준비 보고가 유효한 상대가 없습니다", { timeout: 45_000 });
    await savedHistory();
    check(await page.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1));
  } finally {
    await owned.close();
  }
});

test("should distinguish owner input request from connector application and restore exact retry after refresh", async ({
  browser,
}, info) => {
  const a = await context(browser, info),
    b = await context(browser, info);
  try {
    const scene = sceneName(info, "input-pause");
    const data = await broker<{ roomId: string; owner: BrowserPerson; observer: BrowserPerson }>(
      "setup",
      { scene },
    );
    const page = await a.newPage(),
      observer = await b.newPage();
    await login(page, data.owner);
    await login(observer, data.observer);
    await page.goto(`/app/rooms/${data.roomId}`);
    await observer.goto(`/app/rooms/${data.roomId}`);
    const region = page.getByRole("region", { name: "실제 공동 조사" }),
      own = region.getByLabel("내 AI 새 답변 제어", { exact: true });
    await expect(observer.getByLabel("내 AI 새 답변 제어", { exact: true })).toHaveCount(0);
    const bodies: unknown[] = [];
    await page.route("**/api/investigations/input-control", async (route) => {
      bodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (bodies.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    const pauseInput = own.getByRole("button", { name: /.+ · .+ 새 답변 일시정지$/ });
    await expect(pauseInput).toHaveCount(1);
    const targetName = (await pauseInput.getAttribute("aria-label"))!.replace(
      / 새 답변 일시정지$/,
      "",
    );
    const describedBy = await pauseInput.getAttribute("aria-describedby");
    check(!!describedBy);
    const inputStatus = own.getByRole("status", { name: targetName, exact: true });
    await expect(inputStatus).toHaveAttribute("id", describedBy!);
    await pauseInput.click();
    await expect(own.getByRole("button", { name: "같은 요청 확인", exact: true })).toBeVisible();
    await page.reload();
    await own.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
    await expect(own.getByRole("button", { name: "같은 요청 확인", exact: true })).toHaveCount(0);
    check(bodies.length === 2 && JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]));
    await expect(own.getByText("요청됨 · 연결 프로그램 대기", { exact: true })).toBeVisible();
    await expect(own.getByText("일시정지 적용 보고", { exact: true })).toHaveCount(0);
    await broker("input-drive", { scene, step: "ack-pause" });
    await expect(own.getByText("일시정지 적용 보고", { exact: true })).toBeVisible({
      timeout: 45000,
    });
    await region.getByRole("button", { name: "공동 조사", exact: true }).click();
    await page
      .getByRole("dialog", { name: "공동 조사", exact: true })
      .getByRole("button", { name: "방 일시정지 요청", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(region.getByRole("status", { name: "방 상태", exact: true })).toContainText(
      "일시정지 확인",
      { timeout: 45000 },
    );
    const resumeInput = own.getByRole("button", {
      name: `${targetName} 새 답변 재개`,
      exact: true,
    });
    await expect(resumeInput).toHaveAttribute("aria-describedby", describedBy!);
    await resumeInput.click();
    await broker("input-drive", { scene, step: "ack-resume" });
    await expect(own.getByText("재개 적용 보고", { exact: true })).toBeVisible({ timeout: 45000 });
    await expect(region.getByRole("status", { name: "방 상태", exact: true })).toContainText(
      "일시정지 확인",
    );
    await expect(
      own.getByText("이미 실행 준비를 시작한 답변은 계속됩니다.", { exact: true }),
    ).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

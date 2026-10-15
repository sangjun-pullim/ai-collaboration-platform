import { test, expect, type Browser, type TestInfo, type Page } from "@playwright/test";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
import { enterTeam, type BrowserEntry, type BrowserPerson } from "../helpers/browser-team-entry.js";

installAuthArtifactPolicy(test);
// Real Auth/DB/UI and constructor-only synthetic runtime; this does not verify a native CLI.
type Scene = {
  id: string;
  roomId: string;
  deviceId: string;
  owner: BrowserPerson;
  requester: BrowserPerson;
};
function check(value: unknown): asserts value {
  if (!value)
    throw new Error("Owned settings browser assertion failed; private diagnostics withheld");
}
const brokerActions = [
  "setup",
  "code",
  "record-intent",
  "drive-folder",
  "drive-cancel",
  "drive-apply",
  "drive-ready",
  "drive-question",
  "stale-capability",
  "report-setup",
] as const;
async function fixedStep<T>(
  stage:
    | "codex-folder"
    | "codex-catalog"
    | "codex-cancel-request"
    | "codex-cancel-drive"
    | "codex-new-settings"
    | "guided-folder-request"
    | "guided-folder-report"
    | "guided-sharing-report"
    | "guided-model-report"
    | "guided-failure-report",
  work: () => Promise<T>,
): Promise<T> {
  return test.step(stage, async () => {
    try {
      return await work();
    } catch {
      process.stderr.write(`SETTINGS_CHECK_STAGE ${stage}\n`);
      throw new Error("Owned settings fixed step failed");
    }
  });
}
async function broker<T>(action: string, body: unknown): Promise<T> {
  const endpoint = process.env.LOCAL_SETTINGS_FIXTURE_URL,
    token = process.env.LOCAL_SETTINGS_FIXTURE_TOKEN;
  check(endpoint && token);
  const url = new URL(endpoint);
  check(
    url.hostname === "127.0.0.1" &&
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.port !== "",
  );
  const response = await fetch(`${endpoint}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok && brokerActions.includes(action as (typeof brokerActions)[number]))
    process.stderr.write(`SETTINGS_BROKER_STAGE ${action}\n`);
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
async function login(page: Page, scene: Scene, actor: "owner" | "requester") {
  await enterTeam(page, scene[actor], () =>
    broker<BrowserEntry>("code", { scene: scene.id, actor }),
  );
  // Record the exact UI operation before forwarding its real HTTP request.
  await page.route(
    /\/api\/(?:runtime-settings\/(?:select-folder|select-runtime|apply|cancel)|investigations\/ask)$/,
    async (route) => {
      const request = route.request(),
        body = request.postDataJSON() as Record<string, unknown>;
      const action = new URL(request.url()).pathname.split("/").at(-1)!;
      check(typeof body.operationId === "string");
      await broker("record-intent", {
        scene: scene.id,
        actor,
        action,
        operationId: body.operationId,
        deviceId: scene.deviceId,
      });
      await route.continue();
    },
  );
}
function settings(page: Page) {
  return page
    .getByRole("region", { name: "본인 기기 AI 설정", exact: true })
    .getByRole("region", { name: / AI 설정$/ });
}
async function folder(page: Page, scene: Scene, provider: "claude" | "codex") {
  const form = settings(page);
  await form.getByRole("combobox", { name: "AI 프로그램", exact: true }).selectOption(provider);
  await form.getByRole("button", { name: "Mac에서 폴더 선택", exact: true }).click();
  await expect(form).toContainText("PC 확인 기다림");
  await expect(form).toContainText("아직 PC 적용 확인이 없습니다.");
  await broker("drive-folder", { scene: scene.id });
  await page.reload();
  await expect(settings(page)).toContainText("PC 확인 완료 · 모델 선택");
  return settings(page);
}

test("should distinguish owner Claude request application and readiness and answer a question-only participant", async ({
  browser,
}, info) => {
  const scene = await broker<Scene>("setup", {
      viewport: info.project.name.includes("mobile") ? "mobile" : "desktop",
      scenario: "answer",
    }),
    ownerContext = await context(browser, info),
    requesterContext = await context(browser, info);
  try {
    const owner = await ownerContext.newPage(),
      requester = await requesterContext.newPage();
    await login(owner, scene, "owner");
    await login(requester, scene, "requester");
    await requester.goto("/app/connections");
    await expect(
      requester.getByRole("combobox", { name: "설정할 본인 기기", exact: true }),
    ).toHaveCount(0);
    await expect(
      requester.getByRole("button", { name: "Mac에서 폴더 선택", exact: true }),
    ).toHaveCount(0);
    await requester.getByRole("link", { name: "연결 없이 질문만 하기", exact: true }).click();
    await expect(requester).toHaveURL((url) => url.pathname === `/app/rooms/${scene.roomId}`);
    await owner.goto("/app/connections");
    await expect(
      owner.getByRole("combobox", { name: "설정할 본인 기기", exact: true }),
    ).toBeVisible();
    const form = await folder(owner, scene, "claude");
    await expect(
      form.getByRole("combobox", { name: "모델", exact: true }).getByRole("option"),
    ).toHaveCount(2);
    await expect(
      form.getByRole("option", {
        name: "Synthetic model name (claude-product-synthetic)",
        exact: true,
      }),
    ).toHaveAttribute("value", "claude-product-synthetic");
    await form
      .getByRole("combobox", { name: "모델", exact: true })
      .selectOption("claude-product-synthetic");
    await expect(form.getByRole("combobox", { name: "추론 강도", exact: true })).toHaveCount(0);
    await expect(form).toContainText("이 모델은 별도의 추론 강도 설정을 사용하지 않습니다.");
    const selection = owner.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime-settings/select-runtime") &&
        response.request().method() === "POST",
    );
    check(
      await form.locator("select, input, button").evaluateAll((elements) =>
        elements
          .filter((element) => element.getClientRects().length > 0)
          .every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth + 1;
          }),
      ),
    );
    await form.getByLabel("공개 세션 별칭", { exact: true }).fill("브라우저 Claude AI");
    await form.getByRole("button", { name: "설정 저장", exact: true }).click();
    const selected = await selection;
    check(
      selected.status() === 200 &&
        selected.request().postDataJSON().effort === null &&
        selected.request().postDataJSON().model === "claude-product-synthetic",
    );
    await form.getByRole("button", { name: "설정 상세 · 도움말", exact: true }).click();
    await expect(form.getByLabel("요청한 설정", { exact: true })).toContainText(
      "Synthetic model name (claude-product-synthetic)",
    );

    await expect(form).toContainText("PC 적용 기다림");
    await expect(form.getByLabel("PC에 적용된 설정", { exact: true })).toContainText(
      "아직 PC 적용 확인이 없습니다.",
    );
    const applied = await broker<{ state: string; ready: boolean; agentId: string }>(
      "drive-apply",
      { scene: scene.id },
    );
    check(applied.state === "APPLIED" && applied.ready === false);
    await owner.reload();
    await expect(settings(owner)).toContainText("PC 설정 적용이 확인되었습니다.");
    await expect(settings(owner).getByLabel("PC에 적용된 설정", { exact: true })).toContainText(
      "브라우저 Claude AI",
    );
    await expect(settings(owner)).toContainText(
      "AI 응답 준비는 AI 채팅방의 질문 대상 선택에서 확인하세요.",
    );
    const ready = await broker<{ ready: boolean }>("drive-ready", { scene: scene.id });
    check(ready.ready);
    await requester.reload();
    const question = requester.getByRole("form", { name: "AI에게 질문", exact: true });
    await expect(question.getByLabel("직접 질문 대상", { exact: true })).toHaveValue(
      applied.agentId,
    );
    await expect(question).toContainText("claude");
    await question
      .getByLabel("AI에게 보낼 질문", { exact: true })
      .fill("설정한 한 Claude AI에게만 질문");
    const admitted = requester.waitForResponse(
      (response) =>
        response.url().endsWith("/api/investigations/ask") &&
        response.request().method() === "POST",
    );
    await question.getByRole("button", { name: "AI에 질문 보내기", exact: true }).click();
    check((await admitted).status() === 200);
    const driven = await broker<{ inputs: number; state: string }>("drive-question", {
      scene: scene.id,
    });
    check(driven.inputs === 1 && driven.state === "UPLOADED");
    const records = requester.getByLabel("확정 공동 이력", { exact: true });
    await expect(records).toContainText("선택한 공개 파일로 확인한 합성 제품 답변", {
      timeout: 45000,
    });
    await expect(
      records.getByRole("listitem").filter({ has: requester.getByText("답변", { exact: true }) }),
    ).toHaveCount(1);
    const replay = await broker<{ inputs: number }>("drive-question", { scene: scene.id });
    check(replay.inputs === 1);
    check(await owner.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1));
  } finally {
    await requesterContext.close();
    await ownerContext.close();
  }
});

test("should show the observed Codex catalog and wait for PC cancellation cleanup while refusing foreign editing", async ({
  browser,
}, info) => {
  const scene = await broker<Scene>("setup", {
      viewport: info.project.name.includes("mobile") ? "mobile" : "desktop",
      scenario: "cancel",
    }),
    ownerContext = await context(browser, info),
    requesterContext = await context(browser, info);
  try {
    const owner = await ownerContext.newPage(),
      requester = await requesterContext.newPage();
    await login(owner, scene, "owner");
    await login(requester, scene, "requester");
    await owner.goto("/app/connections");
    const form = await fixedStep("codex-folder", () => folder(owner, scene, "codex"));
    await fixedStep("codex-catalog", async () => {
      await expect(
        form.getByRole("option", {
          name: "Synthetic model name (owned-synthetic)",
          exact: true,
        }),
      ).toHaveAttribute("value", "owned-synthetic");
      await form
        .getByRole("combobox", { name: "모델", exact: true })
        .selectOption("owned-synthetic");
      await expect(form.getByRole("combobox", { name: "추론 강도", exact: true })).toBeVisible();
      await form.getByRole("combobox", { name: "추론 강도", exact: true }).selectOption("high");
      await expect(form).toContainText("Codex 0.159.1");
    });
    await requester.goto("/app/connections");
    await expect(
      requester.getByRole("combobox", { name: "설정할 본인 기기", exact: true }),
    ).toHaveCount(0);
    const refused = await requester.evaluate(async (deviceId) => {
      const response = await fetch("/api/runtime-settings/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      return response.status;
    }, scene.deviceId);
    check(refused === 403 || refused === 404);
    await fixedStep("codex-cancel-request", async () => {
      await form.getByRole("button", { name: "설정 요청 취소", exact: true }).click();
      await expect(form).toContainText("취소 요청됨");
      await expect(form.getByRole("region", { name: "AI와 폴더 선택", exact: true })).toBeHidden();
      await expect(
        form.getByRole("button", { name: "Mac에서 폴더 선택", exact: true, includeHidden: true }),
      ).toBeDisabled();
    });
    const cancelled = await fixedStep("codex-cancel-drive", () =>
      broker<{ state: string }>("drive-cancel", { scene: scene.id }),
    );
    check(cancelled.state === "CANCELLED");
    await fixedStep("codex-new-settings", async () => {
      await expect(settings(owner)).toContainText("취소 · PC 정리 완료", { timeout: 15000 });
      await expect(
        settings(owner).getByRole("button", { name: "Mac에서 폴더 선택", exact: true }),
      ).toBeEnabled();
      await expect(settings(owner).getByLabel("PC에 적용된 설정", { exact: true })).toContainText(
        "아직 PC 적용 확인이 없습니다.",
      );
      const next = owner.waitForResponse(
        (response) =>
          response.url().endsWith("/api/runtime-settings/select-folder") &&
          response.request().method() === "POST",
      );
      await settings(owner)
        .getByRole("combobox", { name: "AI 프로그램", exact: true })
        .selectOption("claude");
      await settings(owner).getByRole("button", { name: "Mac에서 폴더 선택", exact: true }).click();
      const result = await next;
      check(result.status() === 200 && (await result.json()).data.operation.state === "REQUESTED");
      await expect(settings(owner)).toContainText("PC 확인 기다림");
    });
  } finally {
    await requesterContext.close();
    await ownerContext.close();
  }
});

test("should reject a stale capability selection through the real endpoint and keep the owner draft", async ({
  browser,
}, info) => {
  const scene = await broker<Scene>("setup", {
      viewport: info.project.name.includes("mobile") ? "mobile" : "desktop",
      scenario: "stale",
    }),
    ownerContext = await context(browser, info);
  try {
    const owner = await ownerContext.newPage();
    await login(owner, scene, "owner");
    await owner.goto("/app/connections");
    const form = await folder(owner, scene, "claude");
    await form
      .getByRole("combobox", { name: "모델", exact: true })
      .selectOption("claude-product-synthetic");
    await form.getByLabel("공개 세션 별칭", { exact: true }).fill("보존할 공개 별칭");
    const malformed = await broker<{ status: number }>("stale-capability", { scene: scene.id });
    check(malformed.status === 400 || malformed.status === 409);
    await owner.route("**/api/runtime-settings/select-runtime", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await broker("record-intent", {
        scene: scene.id,
        actor: "owner",
        action: "select-runtime",
        operationId: body.operationId,
        deviceId: scene.deviceId,
      });
      // Deliberately submit a stale hash; the response is still produced by the product API.
      await route.continue({ postData: JSON.stringify({ ...body, snapshotHash: "0".repeat(64) }) });
    });
    const response = owner.waitForResponse(
      (item) =>
        item.url().endsWith("/api/runtime-settings/select-runtime") &&
        item.request().method() === "POST",
    );
    await form.getByRole("button", { name: "설정 저장", exact: true }).click();
    check((await response).status() === 409);
    await expect(form.getByRole("alert")).toContainText(
      "설정이나 연결이 변경되었거나 AI가 사용 중입니다.",
    );
    await expect(form.getByLabel("공개 세션 별칭", { exact: true })).toHaveValue(
      "보존할 공개 별칭",
    );
    await expect(form.getByRole("button", { name: "설정 저장", exact: true })).toBeEnabled();
  } finally {
    await ownerContext.close();
  }
});

test("should display only the approved automatic receipt and echo mode only on apply", async ({
  browser,
}, info) => {
  const scene = await broker<Scene>("setup", {
    viewport: info.project.name.includes("mobile") ? "mobile" : "desktop",
    scenario: "automatic",
  });
  const ownerContext = await context(browser, info);
  try {
    const owner = await ownerContext.newPage();
    await login(owner, scene, "owner");
    await owner.goto("/app/connections");
    const form = await folder(owner, scene, "claude");
    await expect(form).toContainText("필요한 코드 자동 탐색");
    await form
      .getByRole("combobox", { name: "모델", exact: true })
      .selectOption("claude-product-synthetic");
    const selection = owner.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime-settings/select-runtime") &&
        response.request().method() === "POST",
    );
    await form.getByLabel("공개 세션 별칭", { exact: true }).fill("자동 탐색 AI");
    const apply = owner.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime-settings/apply") &&
        response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "설정 저장", exact: true }).click();
    check(!Object.hasOwn((await selection).request().postDataJSON(), "readMode"));
    check((await apply).request().postDataJSON().readMode === "AUTO_CODE");
    const applied = await broker<{ state: string }>("drive-apply", { scene: scene.id });
    check(applied.state === "APPLIED");
    await owner.reload();
    await expect(settings(owner)).toContainText("필요한 코드 자동 탐색");
  } finally {
    await ownerContext.close();
  }
});

test("should show native phase hints and finish one save without implying AI readiness", async ({
  browser,
}, info) => {
  const scene = await broker<Scene>("setup", {
    viewport: info.project.name.includes("mobile") ? "mobile" : "desktop",
    scenario: "guided",
  });
  const ownerContext = await context(browser, info);
  try {
    const owner = await ownerContext.newPage();
    await login(owner, scene, "owner");
    await owner.goto("/app/connections");
    const form = settings(owner),
      actions: string[] = [];
    owner.on("request", (request) => {
      if (/\/runtime-settings\/(select-runtime|apply)$/.test(request.url()))
        actions.push(request.url().split("/").at(-1)!);
    });
    await form.getByRole("combobox", { name: "AI 프로그램", exact: true }).selectOption("claude");
    await fixedStep("guided-folder-request", async () => {
      const requested = owner.waitForResponse(
        (response) =>
          response.url().endsWith("/api/runtime-settings/select-folder") &&
          response.request().method() === "POST",
      );
      await form.getByRole("button", { name: "Mac에서 폴더 선택", exact: true }).click();
      const response = await requested;
      check(
        response.status() === 200 && (await response.json()).data.operation.state === "REQUESTED",
      );
      await expect(form).toContainText("PC 확인 기다림");
    });
    await fixedStep("guided-folder-report", async () => {
      await broker("report-setup", { scene: scene.id, stage: "FOLDER_SELECTION", reason: null });
      await expect(form.getByLabel("현재 연결 진행", { exact: true })).toContainText(
        "Mac에서 폴더를 선택하세요",
      );
    });
    await fixedStep("guided-sharing-report", async () => {
      await broker("report-setup", {
        scene: scene.id,
        stage: "SHARING_CONFIRMATION",
        reason: "SHARING_UNCONFIRMED",
      });
      await expect(form.getByLabel("현재 연결 진행", { exact: true })).toContainText(
        "공유 확인이 완료되지 않았습니다",
      );
    });
    await fixedStep("guided-model-report", async () => {
      await broker("report-setup", { scene: scene.id, stage: "MODEL_DISCOVERY", reason: null });
      await expect(form.getByLabel("현재 연결 진행", { exact: true })).toContainText(
        "사용 가능한 모델 확인 중",
      );
    });
    await fixedStep("guided-failure-report", async () => {
      await broker("report-setup", {
        scene: scene.id,
        stage: "FAILED",
        reason: "PROVIDER_UNAVAILABLE",
      });
      await expect(form.getByLabel("현재 연결 진행", { exact: true })).toContainText(
        "AI 프로그램 준비에 실패했습니다",
      );
    });
    await broker("drive-folder", { scene: scene.id });
    await expect(form.getByRole("combobox", { name: "모델", exact: true })).toBeVisible();
    await form.getByLabel("공개 세션 별칭", { exact: true }).fill("한 번 저장 AI");
    await form.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect.poll(() => actions).toEqual(["select-runtime", "apply"]);
    await broker("drive-apply", { scene: scene.id });
    await expect(form.getByLabel("PC에 적용된 설정", { exact: true })).toContainText(
      "한 번 저장 AI",
    );
    await expect(form.getByLabel("PC에 적용된 설정", { exact: true })).toContainText(
      "AI 응답 준비는 AI 채팅방",
    );
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await ownerContext.close();
  }
});
test("should observe lost selection and require explicit save continue after reload", async ({
  browser,
}, info) => {
  const scene = await broker<Scene>("setup", {
    viewport: info.project.name.includes("mobile") ? "mobile" : "desktop",
    scenario: "lost-save",
  });
  const ownerContext = await context(browser, info);
  try {
    const owner = await ownerContext.newPage();
    await login(owner, scene, "owner");
    await owner.goto("/app/connections");
    const form = await folder(owner, scene, "claude");
    let applies = 0;
    owner.on("request", (r) => {
      if (r.url().endsWith("/runtime-settings/apply")) applies++;
    });
    await owner.route("**/api/runtime-settings/select-runtime", async (route) => {
      const body = route.request().postDataJSON();
      await broker("record-intent", {
        scene: scene.id,
        actor: "owner",
        action: "select-runtime",
        operationId: body.operationId,
        deviceId: scene.deviceId,
      });
      await route.fetch();
      await route.abort("failed");
    });
    await form.getByLabel("공개 세션 별칭", { exact: true }).fill("응답 확인 AI");
    await form.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(form.getByRole("button", { name: "설정 저장", exact: true })).toHaveText(
      "저장 계속",
    );
    expect(applies).toBe(0);
    await owner.reload();
    await expect(
      settings(owner).getByRole("button", { name: "설정 저장", exact: true }),
    ).toHaveText("저장 계속");
    expect(applies).toBe(0);
    await settings(owner).getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect.poll(() => applies).toBe(1);
  } finally {
    await ownerContext.close();
  }
});

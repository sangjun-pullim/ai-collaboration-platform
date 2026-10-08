import { test, expect } from "@playwright/test";
import type { Page, Locator } from "@playwright/test";

const draft = "상태 변경 후 캐시를 다시 읽는 순서를 함께 확인해 주세요.";
function timeline(page: Page) {
  return page.locator('ol[aria-label="확정 공동 기록"]');
}
function run(page: Page, name: "A" | "B") {
  return page.getByRole("article", { name: `AI ${name} 실행 확인` });
}
async function create(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "모의 조사방 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "두 저장소의 상태 갱신 차이 조사", exact: true }),
  ).toBeVisible();
}
async function panel(page: Page, area: "shared" | "private") {
  const tab = page.getByRole("tab", {
    name: area === "shared" ? "공동 기록" : "내 AI · 개인 설명",
    exact: true,
  });
  if (await tab.isVisible()) await tab.click();
}
async function openReplay(card: Locator) {
  await card.getByText("모의 확인 단계 재생", { exact: true }).click();
}

test("should create a generic room with visibly simulated bindings", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("heading", { name: "연결할 두 작업 공간" })).toBeVisible();
  await expect(page.getByText("인증 미연결 · 실제 과금 없음", { exact: false })).toHaveCount(2);
  await page.getByLabel("조사 목표", { exact: true }).fill("");
  await page.getByLabel("대상 환경", { exact: true }).fill("");
  await page.getByLabel("예제 연결 A · 내 AI").selectOption("");
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
  await page.getByRole("button", { name: "모의 조사방 만들기" }).click();
  await expect(page.getByLabel("조사 목표", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("대상 환경", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("예제 연결 A · 내 AI")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("공유할 예제 정보의 범위를 하나 이상 선택해 주세요.")).toBeVisible();
  await page.getByLabel("조사 목표", { exact: true }).fill("범용 상태 갱신 조사");
  await page.getByLabel("대상 환경", { exact: true }).fill("격리된 로컬 환경");
  await page.getByLabel("예제 연결 A · 내 AI").selectOption("repository-a");
  await page.getByRole("checkbox", { name: "코드 발췌" }).check();
  await page.getByRole("button", { name: "모의 조사방 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "범용 상태 갱신 조사", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("예제 데이터로 체험 중")).toBeVisible();
  await expect(timeline(page).getByText("src/state.ts:42", { exact: true })).toBeVisible();
  await expect(timeline(page).getByText("예제 snapshot · 실제 코드 검증 아님")).toBeVisible();
});

test("should separate public speech private explanation and steering", async ({ page }) => {
  await create(page);
  const publicInput = page.getByRole("textbox", { name: "공동 발언", exact: true });
  await publicInput.fill("공개 의견 101");
  await page.getByRole("button", { name: "공동 발언 제출" }).click();
  await expect(timeline(page).getByText("공개 의견 101", { exact: true })).toBeVisible();
  await expect(run(page, "A").getByText("모의 조사 중", { exact: true })).toBeVisible();
  await panel(page, "private");
  await page.getByLabel("설명할 공동 메시지").selectOption({ index: 1 });
  await expect(page.getByText("나에게만 · 선택한 공동 기록의 설명 · 조사 실행 없음")).toBeVisible();
  await page.getByRole("textbox", { name: "개인 설명", exact: true }).fill("개인 질문 202");
  await page.getByRole("button", { name: "개인 설명 제출" }).click();
  const history = page.getByRole("region", { name: "개인 설명 기록" });
  await expect(history.getByText("개인 질문 202", { exact: true })).toBeVisible();
  await expect(history.getByText("대상 기록 #2 · AI B", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "미확정 발신 초안" }).getByText(draft, { exact: true }),
  ).toBeVisible();
  await expect(timeline(page).getByText("개인 질문 202", { exact: true })).toHaveCount(0);
  await history.getByRole("button", { name: "선택한 내용만 공동 공개" }).click();
  await expect(timeline(page).getByText("개인 질문 202", { exact: true })).toHaveCount(0);
  await expect(timeline(page).getByText("선택한 기록", { exact: false })).toHaveCount(1);
  await page.getByRole("button", { name: "방향 수정", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "방향 수정", exact: true })).toHaveValue("");
  await expect(
    page.getByText("모든 참가자에게 공개 · 내 AI 종결 확인 후 새 방향 적용"),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "방향 수정", exact: true })
    .fill("재조회 경로부터 조사 303");
  await page.getByRole("button", { name: "방향 수정 제출" }).click();
  await expect(
    page.getByText("방향 적용 대기 · 내 AI 종결 확인 필요", { exact: true }),
  ).toBeVisible();
  await expect(timeline(page).getByText("재조회 경로부터 조사 303", { exact: true })).toHaveCount(
    1,
  );
  await expect(run(page, "B").getByText("모의 조사 중", { exact: true })).toBeVisible();
  await openReplay(run(page, "A"));
  await page.getByRole("button", { name: "AI A connector 확인 재생" }).click();
  await expect(
    page.getByText("방향 적용 대기 · 내 AI 종결 확인 필요", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "AI A 종결 확인 재생" }).click();
  await expect(page.getByText("새 방향 적용됨 · 모의 종결 확인 후", { exact: true })).toBeVisible();
});

test("should keep unsent private and steering drafts separate", async ({ page }) => {
  await create(page);
  await panel(page, "private");
  const privateText = "미전송 개인 원문 PRIVATE-UNSENT-7421";
  const steeringText = "공개 방향 PUBLIC-STEERING-8532 · 재조회 순서부터 확인";
  const privateInput = page.getByRole("textbox", { name: "개인 설명", exact: true });
  const steeringInput = page.getByRole("textbox", { name: "방향 수정", exact: true });
  const outbound = page.getByRole("region", { name: "미확정 발신 초안" });

  await privateInput.fill(privateText);
  await page.getByRole("button", { name: "방향 수정", exact: true }).click();
  await expect(steeringInput).toHaveValue("");
  await steeringInput.fill(steeringText);

  await page.getByRole("button", { name: "개인 설명", exact: true }).click();
  await expect(privateInput).toHaveValue(privateText);
  await page.getByRole("button", { name: "방향 수정", exact: true }).click();
  await expect(steeringInput).toHaveValue(steeringText);
  await page.getByRole("button", { name: "방향 수정 제출" }).click();
  await expect(steeringInput).toHaveValue("");
  await expect(outbound).not.toContainText(privateText);
  await expect(outbound.getByText(draft, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "개인 설명 기록" }).getByRole("article"),
  ).toHaveCount(0);

  await panel(page, "shared");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(3);
  const publicDirection = timeline(page).getByRole("listitem").filter({ hasText: steeringText });
  await expect(publicDirection).toHaveCount(1);
  await expect(publicDirection.getByText("방향 수정", { exact: true })).toBeVisible();
  await expect(publicDirection.getByText(steeringText, { exact: true })).toBeVisible();
  await expect(timeline(page)).not.toContainText(privateText);

  await panel(page, "private");
  await page.getByRole("button", { name: "개인 설명", exact: true }).click();
  await expect(privateInput).toHaveValue(privateText);
  await expect(outbound).not.toContainText(privateText);
});

test("should keep outbound previews out of the shared timeline", async ({ page }) => {
  await create(page);
  await expect(timeline(page).getByText(draft, { exact: true })).toHaveCount(0);
  await panel(page, "private");
  await expect(page.getByRole("button", { name: "발신 초안 확정" })).toBeDisabled();
  await page.getByRole("button", { name: "공개 검사 재생" }).click();
  await expect(timeline(page).getByText(draft, { exact: true })).toHaveCount(0);
  await expect(page.getByText("모의 검사 통과 · 아직 미공개", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "발신 초안 확정" }).click();
  await panel(page, "shared");
  const event = timeline(page).getByRole("listitem").filter({ hasText: draft });
  await expect(event).toHaveCount(1);
  await expect(event.getByText("확정 · 모의 기록", { exact: true })).toBeVisible();
  await panel(page, "private");
  await expect(page.getByRole("button", { name: "발신 초안 확정" })).toHaveCount(0);
});

test("should show pause request acknowledgement and terminal separately", async ({ page }) => {
  await create(page);
  await page.getByRole("button", { name: "전체 일시정지" }).click();
  await expect(
    run(page, "A").getByText("정지 요청됨 · 종결 미확인", { exact: true }),
  ).toBeVisible();
  await expect(
    run(page, "B").getByText("정지 요청됨 · 종결 미확인", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("pause-summary")).toHaveText("방 일시정지 대기 · 종결 확인 필요");
  await openReplay(run(page, "A"));
  await page.getByRole("button", { name: "AI A connector 확인 재생" }).click();
  await expect(
    run(page, "A").getByText("connector 확인 · 종결 미확인", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(100);
  await expect(page.getByTestId("pause-summary")).not.toContainText("완료");
  await page.getByRole("button", { name: "AI A offline 재생" }).click();
  await expect(
    run(page, "A").getByText("UNKNOWN · offline · 종결 확인 필요", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "AI A 종결 확인 재생" }).click();
  await expect(run(page, "A").getByText("종결 확인 · 중단", { exact: true })).toBeVisible();
  await expect(page.getByTestId("pause-summary")).not.toContainText("완료");
  await openReplay(run(page, "B"));
  await page.getByRole("button", { name: "AI B connector 확인 재생" }).click();
  await page.getByLabel("AI B 종결 결과").selectOption("failed");
  await page.getByRole("button", { name: "AI B 종결 확인 재생" }).click();
  await expect(run(page, "B").getByText("종결 확인 · 실패", { exact: true })).toBeVisible();
  await expect(page.getByTestId("pause-summary")).toHaveText(
    "방 일시정지 완료 · 두 실행 종결 확인",
  );
});

test("should separate owned stop from pause across both simulated runs", async ({ page }) => {
  await create(page);
  await panel(page, "private");
  await page.getByRole("button", { name: "내 AI만 정지" }).click();
  await expect(
    run(page, "A").getByText("정지 요청됨 · 종결 미확인", { exact: true }),
  ).toBeVisible();
  await expect(run(page, "B").getByText("모의 조사 중", { exact: true })).toBeVisible();
  await expect(page.getByTestId("pause-summary")).toHaveText("방 일시정지 요청 없음");
  await openReplay(run(page, "A"));
  await page.getByLabel("AI A 종결 결과").selectOption("completed");
  await page.getByRole("button", { name: "AI A 종결 확인 재생" }).click();
  await expect(run(page, "A").getByText("종결 확인 · 정상 완료", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "전체 일시정지" }).click();
  await expect(run(page, "A").getByText("종결 확인 · 정상 완료", { exact: true })).toBeVisible();
  await openReplay(run(page, "B"));
  await page.getByRole("button", { name: "AI B connector 확인 재생" }).click();
  await expect(page.getByTestId("pause-summary")).not.toContainText("완료");
  await page.getByRole("button", { name: "AI B offline 재생" }).click();
  await expect(
    run(page, "B").getByText("UNKNOWN · offline · 종결 확인 필요", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("pause-summary")).not.toContainText("완료");
  await page.getByRole("button", { name: "AI B 종결 확인 재생" }).click();
  await expect(page.getByTestId("pause-summary")).toHaveText(
    "방 일시정지 완료 · 두 실행 종결 확인",
  );
});

test("should allow observation without a connector or writable controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "관찰자로 체험하기 →" }).click();
  await expect(page.getByText("connector 없이 관찰 중", { exact: true })).toBeVisible();
  await expect(timeline(page).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "전체 일시정지" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 공동 기록 재생" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "공동 발언", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "모의 결과 초안 보기" })).toBeDisabled();
  await openReplay(run(page, "A"));
  await expect(page.getByRole("button", { name: "AI A 종결 확인 재생" })).toBeDisabled();
  await panel(page, "private");
  await expect(page.getByRole("button", { name: "내 AI만 정지" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "개인 설명", exact: true })).toBeDisabled();
  await expect(page.getByText("내 연결 없음 · 관찰자", { exact: true })).toBeVisible();
});

test("should show evidence proposals owners and next validation", async ({ page }, testInfo) => {
  await create(page);
  await page.getByRole("button", { name: "모의 결과 초안 보기" }).click();
  const result = page.getByRole("region", { name: "공동 조사 결과 초안" });
  await expect(result.getByText("아직 사람의 판단이 없습니다.", { exact: true })).toBeVisible();
  await expect(result.getByText("원인 가설 · 미확인", { exact: true })).toBeVisible();
  await expect(result.getByText("예제 사실", { exact: true })).toBeVisible();
  await expect(result.getByText("수정 제안", { exact: true })).toBeVisible();
  const a = result.getByRole("article").filter({ hasText: "repository-a" });
  const b = result.getByRole("article").filter({ hasText: "repository-b" });
  await expect(a.getByText("예제 개발자 A", { exact: true })).toBeVisible();
  await expect(
    a.getByText("src/state.ts:42 · demo-a17 (미커밋 변경 포함)", { exact: true }),
  ).toBeVisible();
  await expect(a.getByText("갱신 직후 조회에 대한 회귀 테스트", { exact: true })).toBeVisible();
  await expect(b.getByText("예제 개발자 B", { exact: true })).toBeVisible();
  await expect(b.getByText("양쪽 응답 순서를 바꾸는 통합 검증", { exact: true })).toBeVisible();
  for (const decision of ["해결", "추가 조사", "보류"]) {
    await result.getByRole("button", { name: decision, exact: true }).click();
    await expect(result.getByText(`기록된 판단: ${decision}`, { exact: true })).toBeVisible();
    await expect(
      result.getByText("미검증 · 실제 저장소 테스트를 실행하지 않았습니다.", { exact: true }),
    ).toBeVisible();
    await expect(
      timeline(page)
        .getByRole("listitem")
        .filter({ hasText: "사람 결정" })
        .getByText(decision, { exact: true }),
    ).toHaveCount(1);
    await expect(run(page, "A").getByText("모의 조사 중", { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("result.png"), fullPage: true });
});

test("should preserve controls and focus on a narrow screen", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.screenshot({ path: testInfo.outputPath("setup.png"), fullPage: true });
  await page.getByRole("button", { name: "모의 조사방 만들기" }).click();
  await page.screenshot({ path: testInfo.outputPath("room.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "공동 기록", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const input = page.getByRole("textbox", { name: "공동 발언", exact: true });
  await input.focus();
  await input.fill("포커스 보존 중");
  await page
    .getByRole("button", { name: "다음 공동 기록 재생" })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("포커스 보존 중");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(3);
  await input.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(timeline(page).getByText("포커스 보존 중", { exact: true })).toBeVisible();
  const sharedTab = page.getByRole("tab", { name: "공동 기록", exact: true });
  await sharedTab.focus();
  await sharedTab.press("ArrowRight");
  const privateTab = page.getByRole("tab", { name: "내 AI · 개인 설명", exact: true });
  await expect(privateTab).toBeFocused();
  await expect(privateTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "내 AI만 정지" })).toBeVisible();
  await expect(page.getByRole("button", { name: "전체 일시정지" })).toBeVisible();
  await expect(page.getByRole("region", { name: "실행 확인 및 전체 일시정지" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-private.png"), fullPage: true });
  await privateTab.press("ArrowLeft");
  await expect(sharedTab).toBeFocused();
  await expect(sharedTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "공동 발언", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-shared.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "전체 일시정지" }).focus();
  await page.getByRole("button", { name: "전체 일시정지" }).press("Enter");
  await expect(page.getByTestId("pause-summary")).toHaveText("방 일시정지 대기 · 종결 확인 필요");
});

test("should not submit an input while korean composition is active", async ({ page }) => {
  await create(page);
  const input = page.getByRole("textbox", { name: "공동 발언", exact: true });
  await input.focus();
  await input.fill("한글 조합 중");
  await input.dispatchEvent("compositionstart", { data: "한" });
  await input.press("Enter");
  await expect(input).toHaveValue(/한글 조합 중/);
  await expect(timeline(page).getByText("한글 조합 중", { exact: true })).toHaveCount(0);
  await input.dispatchEvent("compositionend", { data: "한글" });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await expect(timeline(page).getByText("한글 조합 중", { exact: true })).toHaveCount(0);
  await input.press("Shift+Enter");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(2);
  await input.fill("정상 Enter 제출");
  await input.press("Enter");
  await expect(timeline(page).getByText("정상 Enter 제출", { exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill("명시적 버튼 제출");
  await page.getByRole("button", { name: "공동 발언 제출" }).click();
  await expect(timeline(page).getByText("명시적 버튼 제출", { exact: true })).toBeVisible();
  await panel(page, "private");
  const privateInput = page.getByRole("textbox", { name: "개인 설명", exact: true });
  await privateInput.fill("비공개 한글 조합");
  await privateInput.dispatchEvent("compositionstart", { data: "한" });
  await privateInput.press("Enter");
  await expect(
    page
      .getByRole("region", { name: "개인 설명 기록" })
      .getByText("비공개 한글 조합", { exact: true }),
  ).toHaveCount(0);
  await privateInput.dispatchEvent("compositionend", { data: "한글" });
  await privateInput.press("Enter");
  await expect(
    page
      .getByRole("region", { name: "개인 설명 기록" })
      .getByText("비공개 한글 조합", { exact: true }),
  ).toBeVisible();
  await expect(timeline(page).getByText("비공개 한글 조합", { exact: true })).toHaveCount(0);
});

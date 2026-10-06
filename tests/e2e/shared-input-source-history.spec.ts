import { test, expect, type BrowserContext } from "@playwright/test";
import type { SourceBrowserScene } from "../helpers/source-browser-fixture.js";
import { enterTeam, clearAuthCookies, type BrowserEntry } from "../helpers/browser-team-entry.js";
import { installAuthArtifactPolicy } from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);

async function broker<T>(
  action: "source-setup" | "source-code" | "source-dispose",
  body: unknown,
): Promise<T> {
  const endpoint = process.env.LOCAL_WORKFLOW_FIXTURE_URL,
    token = process.env.LOCAL_WORKFLOW_FIXTURE_TOKEN;
  if (!endpoint || !token || new URL(endpoint).hostname !== "127.0.0.1")
    throw new Error("Owned source parent broker required");
  const response = await fetch(`${endpoint}/${action}`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Owned source parent broker failed");
  return response.json() as Promise<T>;
}
// Actual owned HTTP/browser acceptance definition. It never starts an AI provider.
test("should lazily show the same historical source for two people and clear room input on access loss", async ({
  browser,
}, info) => {
  const sceneName = `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-source-history`;
  let scene: SourceBrowserScene | undefined;
  let owner: BrowserContext | undefined;
  let observer: BrowserContext | undefined;
  try {
    owner = await browser.newContext({
      baseURL: process.env.APP_ORIGIN,
      viewport: info.project.use.viewport,
      isMobile: info.project.use.isMobile,
      hasTouch: info.project.use.hasTouch,
    });
    observer = await browser.newContext({
      baseURL: process.env.APP_ORIGIN,
      viewport: info.project.use.viewport,
      isMobile: info.project.use.isMobile,
      hasTouch: info.project.use.hasTouch,
    });
    scene = await broker<SourceBrowserScene>("source-setup", { scene: sceneName });
    const { question, recipient, original, eventId } = scene;
    expect(original.summary?.readMode).toBe("AUTO_CODE");
    expect(original.summary?.fileCount).toBe(6);
    for (const [context, person] of [
      [owner, scene.owner],
      [observer, scene.observer],
    ] as const) {
      const page = await context.newPage();
      await enterTeam(page, person, () =>
        broker<BrowserEntry>("source-code", { scene: sceneName, id: person.id }),
      );
      const reads: { eventId: string; afterIndex: number | null }[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/api/investigations/source-read")
        )
          reads.push(request.postDataJSON());
      });
      await page.goto(`/app/rooms/${scene.roomId}`);
      const region = page.getByRole("region", { name: "실제 공동 조사" });
      const record = region
        .getByLabel("확정 공동 이력")
        .getByRole("listitem")
        .filter({ has: page.getByText("당시 저장소의 공개 답변", { exact: true }) });
      await expect(record).toBeVisible();
      expect(reads).toHaveLength(0);
      await record.getByRole("button", { name: "저장소·자료", exact: true }).click();
      const details = record.getByRole("region", { name: "당시 저장소·자료" });
      await expect(details).toContainText(original.manifestHash!);
      await expect(details).toContainText(original.target!.sessionAlias);
      await expect(details).toContainText(original.target!.repositoryAlias);
      await expect(details.getByLabel("저장된 파일 관찰").getByRole("listitem")).toHaveCount(
        original.files.length,
      );
      expect(reads).toEqual([
        { protocol: 1, roomId: scene.roomId, eventId: eventId, afterIndex: null },
      ]);
      await details.getByRole("button", { name: "다음 파일 관찰", exact: true }).click();
      await expect(details.getByLabel("저장된 파일 관찰").getByRole("listitem")).toHaveCount(6);
      expect(reads[1].afterIndex).toBe(original.nextIndex);
      await expect(
        details.getByRole("button", { name: "다음 파일 관찰", exact: true }),
      ).toHaveCount(0);
      await record.getByRole("button", { name: "저장소·자료 닫기", exact: true }).click();
      await expect(details).toHaveCount(0);
      await record.getByRole("button", { name: "저장소·자료", exact: true }).click();
      await expect(details).toContainText(original.manifestHash!);
      expect(reads).toHaveLength(2);
      const peerRecord = region
        .getByLabel("확정 공동 이력")
        .getByRole("listitem")
        .filter({ has: page.getByText(question.publicText, { exact: true }) });
      await peerRecord.getByRole("button", { name: "저장소·자료", exact: true }).click();
      const peerDetails = peerRecord.getByRole("region", { name: "당시 저장소·자료" });
      await expect(peerDetails).toContainText(recipient.target!.ownerAlias);
      await expect(peerDetails).toContainText(recipient.target!.repositoryAlias);
      await expect(peerDetails).toContainText(recipient.target!.sessionAlias);
      await expect(peerRecord).toContainText(
        "당시 대상은 저장되어 있으나 파일 관찰 자료는 없습니다.",
      );
      if (person === scene.owner) {
        await peerRecord.getByRole("button", { name: "저장소·자료 닫기", exact: true }).click();
        await page.reload();
        await expect(record).toBeVisible();
        await record.getByRole("button", { name: "저장소·자료", exact: true }).click();
        await expect(
          record.getByRole("button", { name: "다음 파일 관찰", exact: true }),
        ).toBeVisible();
        await clearAuthCookies(context);
        await record.getByRole("button", { name: "다음 파일 관찰", exact: true }).click();
        await expect(region.getByRole("alert", { name: "조사 오류", exact: true })).toBeVisible();
        await expect(region.getByLabel("확정 공동 이력")).toContainText("대화를 시작하세요.");
        await expect(region.getByLabel("확정 공동 이력")).not.toContainText(
          "당시 저장소의 공개 답변",
        );
        await expect(region.getByRole("form", { name: "상대 AI에 직접 질문" })).toHaveCount(0);
        await expect(region.getByRole("region", { name: "당시 저장소·자료" })).toHaveCount(0);
      }
    }
  } finally {
    const cleanup = await Promise.allSettled([owner?.close(), observer?.close()]);
    if (scene) await broker("source-dispose", { scene: sceneName });
    if (cleanup.some((result) => result.status === "rejected"))
      throw new Error("Owned source browser cleanup failed");
  }
});

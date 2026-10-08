import { expect, type BrowserContext, type Page } from "@playwright/test";

export type BrowserPerson = { id: string; displayName: string };
export type BrowserEntry = {
  code: string;
  cookies: Parameters<BrowserContext["addCookies"]>[0];
};
function check(value: unknown): asserts value {
  if (!value) throw new Error("Owned team entry assertion failed");
}
export async function clearAuthCookies(context: BrowserContext) {
  // Remove the base cookie, every stale chunk and the PKCE verifier on actor swaps.
  await context.clearCookies({ name: /^sb-.+-auth-token(?:-code-verifier)?(?:\.\d+)?$/ });
}
export async function prepareTeamEntry(
  page: Page,
  loadEntry: () => Promise<BrowserEntry>,
  loginPath = "/login",
) {
  await clearAuthCookies(page.context());
  await page.goto(loginPath);
  await expect(page.getByLabel("회사 입장 코드", { exact: true })).toBeVisible();
  const entry = await loadEntry();
  check(typeof entry.code === "string" && entry.cookies.length > 0);
  await clearAuthCookies(page.context());
  await page.context().addCookies(entry.cookies);
  return entry;
}
export async function submitTeamEntry(
  page: Page,
  person: BrowserPerson,
  entry: BrowserEntry,
  displayName = person.displayName,
) {
  await page.getByLabel("회사 입장 코드", { exact: true }).fill(entry.code);
  await page.getByLabel("표시 이름", { exact: true }).fill(displayName);
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/auth/enter"),
  );
  await page.getByRole("button", { name: "입장하기", exact: true }).click();
  const result = await response;
  check(result.status() === 200);
  const body = await result.json();
  // Never print a provider body or either identity in assertion diagnostics.
  check(body.ok === true && body.data?.userId === person.id);
  check(body.data.displayName === displayName);
  await expect(page).toHaveURL((url) => url.pathname === "/app");
  const invites = new URL(page.url()).searchParams.getAll("invite");
  if (invites.length === 1 && /^[a-f0-9]{64}$/.test(invites[0])) {
    const invitation = page.getByRole("dialog", { name: "초대로 참가", exact: true });
    await expect(invitation).toBeVisible();
    check((await invitation.getByLabel("초대 코드", { exact: true }).inputValue()) === invites[0]);
  } else {
    await expect(page.getByRole("heading", { name: "내 AI 채팅방", exact: true })).toBeVisible();
  }
}
export async function enterTeam(
  page: Page,
  person: BrowserPerson,
  loadEntry: () => Promise<BrowserEntry>,
  displayName = person.displayName,
  loginPath = "/login",
) {
  const entry = await prepareTeamEntry(page, loadEntry, loginPath);
  await submitTeamEntry(page, person, entry, displayName);
}

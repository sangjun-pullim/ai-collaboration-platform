import { setTimeout as delay } from "node:timers/promises";

export async function waitForFixtureEntry(
  read: () => Promise<{ active: number; nextWaitMs: number }>,
  clock = () => performance.now(),
  wait = (ms: number) => delay(ms),
) {
  const deadline = clock() + 65_000;
  while (clock() < deadline) {
    const hint = await read();
    if (!Number.isInteger(hint.active) || hint.active < 0 || !Number.isFinite(hint.nextWaitMs))
      throw new Error("Invalid owned entry quota observation");
    if (hint.active < 60) return;
    await wait(Math.max(50, Math.min(1000, hint.nextWaitMs + 25)));
  }
  throw new Error("Owned fixture entry quota did not become available");
}

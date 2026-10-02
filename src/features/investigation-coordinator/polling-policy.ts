// Backfill is activity too; hidden tabs and failed requests stay bounded.
export function pollingDelay(active: boolean, hidden: boolean, failures: number): number {
  if (hidden) return 30_000;
  if (failures > 0) return Math.min(30_000, 10_000 * 2 ** Math.min(failures, 2));
  return active ? 2_000 : 10_000;
}

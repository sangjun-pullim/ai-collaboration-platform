/** Reports are serial, best effort, and owned until an in-flight request settles. */
export async function reportConnectionHeartbeat(
  report: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await report(signal);
    } catch {
      // A background report must neither expose errors nor mutate authentication state.
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 30_000);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}

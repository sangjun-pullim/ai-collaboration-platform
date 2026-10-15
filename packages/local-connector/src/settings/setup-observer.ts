import {
  projectObservation,
  type SetupIdentity,
  type SetupStage,
  type SetupReason,
  type SetupReport,
  type ObservationResponse,
} from "./setup-contracts.ts";
export type SetupTransport = (
  action: "settings-inspect" | "settings-report",
  body: SetupIdentity | SetupReport,
  timeoutMs: number,
) => Promise<ObservationResponse>;
/** One operation owns one observer. Observation failures never affect its receipts. */
export class SetupObserver {
  private stopped = false;
  private running = false;
  private readonly identity: SetupIdentity;
  private pending: { stage: SetupStage; reason: SetupReason | null } | null = null;
  private flight: Promise<void> | null = null;
  private sequence: number | null = null;
  constructor(
    identity: SetupIdentity,
    private readonly transport: SetupTransport,
  ) {
    this.identity = Object.freeze({ ...identity });
  }

  report(stage: SetupStage, reason: SetupReason | null = null): void {
    if (this.stopped) return;
    this.pending = { stage, reason };
    if (!this.running) this.begin();
  }

  private begin() {
    this.running = true;
    this.flight = this.flush().finally(() => {
      this.running = false;
      this.flight = null;
      if (!this.stopped && this.pending) this.begin();
    });
  }

  private async bounded<T>(work: Promise<T>, timeoutMs = 2000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("UNAVAILABLE")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async flush() {
    while (!this.stopped && this.pending) {
      const deadline = Date.now() + 2000;
      const remaining = () => Math.max(1, deadline - Date.now());
      const change = this.pending;
      this.pending = null;
      try {
        if (this.sequence === null) {
          const current = projectObservation(
            await this.bounded(this.transport("settings-inspect", this.identity, remaining())),
          );
          if (current.observation && !this.matches(current.observation)) return;
          if (this.stopped) return;
          this.sequence = current.sequence;
        }
        if (Date.now() >= deadline || this.stopped) return;
        const body = { ...this.identity, ...change, sequence: this.sequence + 1 };
        const result = projectObservation(
          await this.bounded(this.transport("settings-report", body, remaining()), remaining()),
        );
        if (
          result.sequence !== body.sequence ||
          !result.observation ||
          !this.matches(result.observation) ||
          result.observation.stage !== body.stage ||
          result.observation.reason !== body.reason
        )
          throw new Error("UNAVAILABLE");
        this.sequence = result.sequence;
      } catch {
        // Re-read before a later real change, including after an ambiguous write.
        this.sequence = null;
        this.pending = null;
        return;
      }
    }
  }

  private matches(value: SetupIdentity) {
    return (
      value.deviceId === this.identity.deviceId &&
      value.operationId === this.identity.operationId &&
      value.configRevision === this.identity.configRevision
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending = null;
    if (this.flight) {
      try {
        await this.bounded(this.flight);
      } catch {
        /* Best effort only. */
      }
    }
  }
}

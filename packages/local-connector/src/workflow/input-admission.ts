import { projectResponse, type InputState } from "../workflow-contracts.ts";

/** Independent admission for new claims; it never cancels an admitted native attempt. */
export class InputAdmission {
  private open = false;
  private stopped = false;
  private revision = 0;
  private paused: boolean | undefined;
  private acknowledgedRevision = 0;
  private work: Promise<boolean> | undefined;
  constructor(
    readonly agentId: string,
    readonly bindingEpoch: number,
  ) {}
  get allowed() {
    return this.open && !this.stopped;
  }
  close() {
    this.stopped = true;
    this.open = false;
  }
  refresh(
    read: () => Promise<unknown>,
    ack: (state: InputState) => Promise<unknown>,
  ): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.work) return this.work;
    const run = async () => {
      try {
        const desired = projectResponse("admission", await read()) as InputState;
        if (
          this.stopped ||
          desired.agentId !== this.agentId ||
          desired.bindingEpoch !== this.bindingEpoch ||
          desired.revision < this.revision ||
          (desired.revision === this.revision &&
            this.paused !== undefined &&
            desired.paused !== this.paused)
        ) {
          this.open = false;
          return false;
        }
        if (
          this.acknowledgedRevision === desired.revision &&
          desired.revision === this.revision &&
          desired.paused === this.paused &&
          desired.appliedRevision === desired.revision &&
          desired.appliedEpoch === this.bindingEpoch &&
          desired.appliedAt !== null
        ) {
          this.open = !desired.paused;
          return this.allowed;
        }
        this.revision = desired.revision;
        this.paused = desired.paused;
        this.open = false;
        const applied = projectResponse("admission-ack", await ack(desired)) as InputState;
        if (
          this.stopped ||
          applied.agentId !== this.agentId ||
          applied.bindingEpoch !== this.bindingEpoch ||
          applied.revision !== this.revision ||
          applied.paused !== this.paused ||
          applied.appliedRevision !== this.revision ||
          applied.appliedEpoch !== this.bindingEpoch ||
          applied.appliedAt === null
        )
          return false;
        this.acknowledgedRevision = applied.revision;
        this.open = !applied.paused;
        return this.allowed;
      } catch {
        this.open = false;
        return false;
      }
    };
    const work = run();
    this.work = work;
    void work.finally(() => {
      if (this.work === work) this.work = undefined;
    });
    return work;
  }
}

import { WorkflowError, type Body, type HumanAction } from "./contracts.ts";
import { sourceStableJson, validSourceReadPage, type SourceReadPage } from "./source-contracts.ts";

export type SourceRequest = (
  action: HumanAction,
  body: Body,
  signal: AbortSignal,
) => Promise<unknown>;
export type SourceViewState = {
  open: boolean;
  busy: boolean;
  page: SourceReadPage | null;
  error: "UNAVAILABLE" | "ACCESS_LOST" | null;
};

// One controller owns one immutable event address; there is no polling or shared cache.
export class SourceViewController {
  private view: SourceViewState = { open: false, busy: false, page: null, error: null };
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private abort: AbortController | null = null;

  constructor(
    readonly roomId: string,
    readonly eventId: string,
    private request: SourceRequest,
    private onAccessLost: () => void,
  ) {}

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<SourceViewState>) {
    this.view = { ...this.view, ...change };
    this.listeners.forEach((listener) => listener());
  }

  setCallbacks(request: SourceRequest, onAccessLost: () => void) {
    this.request = request;
    this.onAccessLost = onAccessLost;
  }

  start() {
    this.active = true;
  }

  async open() {
    if (!this.active || this.view.busy) return;
    this.update({ open: true });
    if (!this.view.page) await this.load(null);
  }

  close() {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.update({ open: false, busy: false, error: null });
  }

  stop() {
    this.active = false;
    this.close();
    this.update({ page: null });
  }

  async next() {
    if (!this.active || !this.view.open || this.view.busy || this.view.page?.nextIndex == null)
      return;
    await this.load(this.view.page.nextIndex);
  }

  async retry() {
    if (!this.active || !this.view.open || this.view.busy) return;
    await this.load(this.view.page?.nextIndex ?? null);
  }

  private async load(afterIndex: number | null) {
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.update({ busy: true, error: null });
    try {
      const result = await this.request(
        "source-read",
        { protocol: 1, roomId: this.roomId, eventId: this.eventId, afterIndex },
        abort.signal,
      );
      if (!this.active || !this.view.open || generation !== this.generation || abort.signal.aborted)
        return;
      const previous = this.view.page;
      if (
        !validSourceReadPage(result) ||
        result.roomId !== this.roomId ||
        result.eventId !== this.eventId ||
        (result.state === "CONFIRMED" &&
          (result.files.length === 0
            ? result.summary!.fileCount !== 0 || afterIndex !== null
            : result.files[0].index !== (afterIndex === null ? 0 : afterIndex + 1))) ||
        (previous &&
          sourceStableJson({ ...previous, files: [], nextIndex: null }) !==
            sourceStableJson({ ...result, files: [], nextIndex: null }))
      )
        throw new WorkflowError("UNAVAILABLE");
      const page = structuredClone(result);
      if (previous) page.files = [...previous.files, ...page.files];
      this.update({ page, busy: false });
    } catch (error) {
      if (!this.active || !this.view.open || generation !== this.generation || abort.signal.aborted)
        return;
      const accessLost =
        error instanceof WorkflowError &&
        ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"].includes(error.code);
      this.update({
        busy: false,
        error: accessLost ? "ACCESS_LOST" : "UNAVAILABLE",
        ...(accessLost ? { page: null } : {}),
      });
      if (accessLost) {
        this.active = false;
        this.onAccessLost();
      }
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }
}

import {
  sourceExact,
  validSourceReadPage,
  type SourceReadPage,
} from "../../src/features/investigation-coordinator/source-contracts.ts";

export type SourceBrowserPerson = { id: string; displayName: string };
export type SourceBrowserScene = {
  roomId: string;
  owner: SourceBrowserPerson;
  observer: SourceBrowserPerson;
  eventId: string;
  question: { eventId: string; publicText: string };
  original: SourceReadPage;
  recipient: SourceReadPage;
};
export type SourceBrowserEntry = {
  code: string;
  cookies: { name: string; value: string; url: string; httpOnly: boolean; sameSite: "Lax" }[];
};
export interface SourceBrowserOperations<T> {
  prepare(scene: string): Promise<{ state: T; publicScene: SourceBrowserScene }>;
  entry(state: T, personId: string): Promise<SourceBrowserEntry>;
  dispose(state: T): Promise<void>;
}
/** Parent-only registry. The child selects fixed scenes and scoped test users, never operations. */
export class SourceBrowserRegistry<T> {
  private readonly scenes = new Map<string, { state: T; publicScene: SourceBrowserScene }>();
  private readonly pending = new Set<string>();
  private readonly used = new Set<string>();
  constructor(private readonly operations: SourceBrowserOperations<T>) {}
  async dispatch(action: string, input: unknown): Promise<unknown> {
    if (
      !sourceExact(input, action === "source-code" ? ["scene", "id"] : ["scene"]) ||
      typeof input.scene !== "string" ||
      !/^(?:desktop|mobile)-source-history$/.test(input.scene) ||
      !["source-setup", "source-code", "source-dispose"].includes(action)
    )
      throw new Error("Invalid fixed source browser request");
    const scene = input.scene;
    if (action === "source-setup") {
      if (this.used.has(scene) || this.pending.has(scene))
        throw new Error("Duplicate source browser scene");
      this.pending.add(scene);
      this.used.add(scene);
      try {
        const prepared = await this.operations.prepare(scene);
        const p = prepared.publicScene;
        if (
          !validSourceReadPage(p.original) ||
          !validSourceReadPage(p.recipient) ||
          p.original.roomId !== p.roomId ||
          p.recipient.roomId !== p.roomId ||
          p.original.eventId !== p.eventId ||
          p.recipient.eventId !== p.question.eventId
        ) {
          await this.operations.dispose(prepared.state);
          throw new Error("Invalid public source browser scene");
        }
        this.scenes.set(scene, prepared);
        // Explicit projection excludes parent state and any extra fields returned by an operation.
        return {
          roomId: p.roomId,
          owner: { id: p.owner.id, displayName: p.owner.displayName },
          observer: { id: p.observer.id, displayName: p.observer.displayName },
          eventId: p.eventId,
          question: { eventId: p.question.eventId, publicText: p.question.publicText },
          original: p.original,
          recipient: p.recipient,
        } satisfies SourceBrowserScene;
      } finally {
        this.pending.delete(scene);
      }
    }
    const prepared = this.scenes.get(scene);
    if (!prepared) throw new Error("Unowned source browser scene");
    if (action === "source-code") {
      if (
        typeof input.id !== "string" ||
        ![prepared.publicScene.owner.id, prepared.publicScene.observer.id].includes(input.id)
      )
        throw new Error("Unowned source browser person");
      const entry = await this.operations.entry(prepared.state, input.id);
      return {
        code: entry.code,
        cookies: entry.cookies.map(({ name, value, url, httpOnly, sameSite }) => ({
          name,
          value,
          url,
          httpOnly,
          sameSite,
        })),
      } satisfies SourceBrowserEntry;
    }
    await this.operations.dispose(prepared.state);
    this.scenes.delete(scene);
    return { closed: true };
  }
  async close() {
    const failures: unknown[] = [];
    for (const [scene, prepared] of this.scenes) {
      try {
        await this.operations.dispose(prepared.state);
        this.scenes.delete(scene);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Source browser registry cleanup failed");
  }
}

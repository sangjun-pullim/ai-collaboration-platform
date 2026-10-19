export const STORAGE_BUDGET = 1_000_000_000;
export const EGRESS_BUDGET = 2_000_000_000;
export const CLEANUP_BATCH = 32;
export const CLEANUP_MILLISECONDS = 10_000;
export type AttachmentRpc = (
  name: string,
  params: Record<string, unknown>,
  options?: { timeoutMilliseconds: number },
) => Promise<unknown>;
export interface ImageStorage {
  put(id: string, bytes: Buffer, mime: string): Promise<void>;
  get(id: string): Promise<Buffer>;
  remove(id: string, timeoutMilliseconds?: number): Promise<void>;
}

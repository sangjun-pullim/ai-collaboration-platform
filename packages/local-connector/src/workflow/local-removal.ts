import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { StateStore } from "../state-store.ts";
import { RuntimeError, stableJson, type RuntimeScope } from "../runtime-contracts.ts";
import { unresolvedRuntime, type RuntimeStore } from "../runtime-store.ts";

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

export async function withLocalRemovalProtection<T>(
  {
    store,
    profile: profileStore,
    origin,
    check,
    trackRemoval,
    drain,
  }: {
    store: RuntimeStore;
    profile: StateStore;
    origin: string;
    check(): void;
    trackRemoval(run: () => Promise<void>): Promise<void>;
    drain(): Promise<void>;
  },
  mutation: (proof: {
    check(): void;
    validate(): Promise<void>;
    remove(): Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const saved = await store.read();
  check();
  const owner = await profileStore.read();
  check();
  const mappings = owner?.mappings.filter((mapping) => mapping.agentId === store.agentId) ?? [];
  const mapping = mappings[0];
  if (
    !owner ||
    owner.server !== origin ||
    !owner.deviceId ||
    !owner.scope ||
    mappings.length !== 1 ||
    !Number.isSafeInteger(mapping.bindingEpoch) ||
    mapping.bindingEpoch! < 1
  )
    throw new RuntimeError("AUTHORITY_LOST");
  if (owner.pending || owner.registration) throw new RuntimeError("RUNTIME_BUSY");
  const scope: RuntimeScope = {
    server: owner.server,
    deviceId: owner.deviceId,
    organizationId: owner.scope.organizationId,
    roomId: owner.scope.roomId,
    agentId: store.agentId,
    bindingEpoch: mapping.bindingEpoch!,
  };
  if (
    saved &&
    (!same(saved.scope, scope) ||
      (saved.context &&
        (saved.context.root.path !== mapping.root ||
          saved.context.threadId !== mapping.nativeSessionId)))
  )
    throw new RuntimeError("AUTHORITY_LOST");
  if (saved && unresolvedRuntime(saved)) throw new RuntimeError("RUNTIME_BUSY");
  let removed = false;
  const validate = async () => {
    check();
    const current = await store.read();
    check();
    const profile = await profileStore.read();
    check();
    if (!same(current, saved) || !same(profile, owner)) throw new RuntimeError("AUTHORITY_LOST");
    if (current && unresolvedRuntime(current)) throw new RuntimeError("RUNTIME_BUSY");
  };
  const remove = () => {
    return trackRemoval(async () => {
      if (removed) throw new RuntimeError("RUNTIME_CLOSED");
      await validate();
      check();
      if (saved) {
        const before = await lstat(store.file);
        check();
        await validate();
        check();
        const current = await lstat(store.file);
        check();
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.uid !== process.getuid?.() ||
          (current.mode & 0o777) !== 0o600 ||
          current.nlink !== 1 ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs
        )
          throw new RuntimeError("UNSAFE_STORAGE");
        // The secure store read verifies schema/ownership. Guard the actual unlink after its
        // final await and retain the binding/session locks until dispatched filesystem work ends.
        check();
        await unlink(store.file);
        check();
        const directory = await open(store.dir, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          check();
          await directory.sync();
          check();
        } finally {
          await directory.close();
        }
      }
      removed = true;
    });
  };
  // No provider/server work is admitted here. The caller holds every owned protection and
  // revalidates all immutable proofs under the original profile transaction before deletion.
  const execute = async () => {
    try {
      await validate();
      check();
      const result = await mutation({ check: check, validate, remove });
      check();
      return result;
    } finally {
      await drain();
    }
  };
  return saved?.context
    ? await store.sessionLocked(saved.context.threadId, execute)
    : await execute();
}

import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { RuntimeStore } from "../runtime-store.ts";
import { RuntimeError, stableJson } from "../runtime-contracts.ts";
import type { StateStore } from "../state-store.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";

export async function revokeLocalProfile(
  store: StateStore,
  runner: (agentId: string) => WorkflowRunner,
) {
  const snapshot = await store.read(),
    storedAgents = await RuntimeStore.agents(store.dir, store.profile);
  const agents = [
    ...new Set([
      ...storedAgents,
      ...(snapshot?.mappings.flatMap((mapping) => (mapping.agentId ? [mapping.agentId] : [])) ??
        []),
    ]),
  ].sort();
  const protections: { check(): void; validate(): Promise<void>; remove(): Promise<void> }[] = [];
  const check = () => {
    for (const proof of protections) proof.check();
  };
  const remove = async (index: number): Promise<unknown> => {
    if (index < agents.length)
      return runner(agents[index]).guardLocalRemoval(async (proof) => {
        protections.push(proof);
        try {
          return await remove(index + 1);
        } finally {
          protections.pop();
        }
      });
    return store.transaction(async () => {
      check();
      const current = await store.read();
      check();
      if (stableJson(current) !== stableJson(snapshot)) throw new RuntimeError("AUTHORITY_LOST");
      const currentAgents = await RuntimeStore.agents(store.dir, store.profile);
      check();
      if (currentAgents.some((agent) => !agents.includes(agent)))
        throw new RuntimeError("RUNTIME_BUSY");
      for (const proof of protections) {
        await proof.validate();
        check();
      }
      for (const proof of protections) {
        check();
        await proof.remove();
        check();
      }
      if (protections.length && snapshot) {
        const before = await lstat(store.file);
        check();
        const final = await store.read();
        check();
        if (stableJson(final) !== stableJson(snapshot)) throw new RuntimeError("AUTHORITY_LOST");
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
      } else {
        check();
        await store.remove();
        check();
      }
      return { state: "removed", scope: "local profile" };
    }, check);
  };
  return remove(0);
}

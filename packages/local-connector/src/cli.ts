#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CentralClient } from "./central-client.ts";
import { StateStore, type ConnectorState, type Pending, type Mapping } from "./state-store.ts";
import {
  ConnectionError,
  validateBody,
  type Body,
  type Scope,
  type WorkspaceMetadata,
} from "./contracts.ts";
import { canonicalRoot, gitMetadata, workspaceBody, agentBody } from "./workspace-registration.ts";
import { RuntimeStore } from "./runtime-store.ts";
import { RuntimeError, stableJson } from "./runtime-contracts.ts";
import { RuntimeFilePolicy } from "./runtime-file-policy.ts";
import { WorkflowRunner } from "./workflow-runner.ts";
import { WorkflowClient } from "./workflow-client.ts";
import { CodexAdapter } from "./codex-adapter.ts";
import type { PublicBinding } from "./contracts.ts";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class Connector {
  constructor(
    readonly store: StateStore,
    readonly client: CentralClient,
  ) {}
  private async state() {
    const state = await this.store.read();
    if (!state || state.server !== this.client.origin) throw new ConnectionError("CONFLICT");
    return state;
  }
  private usable(state: ConnectorState) {
    if (
      state.status !== "connected" ||
      !state.credential ||
      !state.credentialExpiresAt ||
      Date.parse(state.credentialExpiresAt) <= Date.now()
    )
      throw new ConnectionError("UNAUTHENTICATED");
    if (state.pending || state.registration) throw new ConnectionError("CONFLICT");
  }
  private async journal(
    state: ConnectorState,
    action: Pending["action"],
    body: Body,
    secret?: string,
    candidateCredential?: string,
    candidate?: Mapping,
    assertLive = () => {},
  ) {
    assertLive();
    if (state.pending) throw new ConnectionError("CONFLICT");
    state.pending = {
      action,
      body,
      secret,
      candidateCredential,
      candidate,
      payloadHash: hash(JSON.stringify(body)),
    };
    await this.store.write(state, assertLive);
    assertLive();
  }
  private async send(state: ConnectorState, assertLive = () => {}) {
    assertLive();
    const pending = state.pending;
    if (!pending) throw new ConnectionError("CONFLICT");
    let result: Record<string, unknown>;
    try {
      result = await this.client.call(pending.action, pending.body, pending.secret);
      assertLive();
    } catch (error) {
      assertLive();
      if (
        error instanceof ConnectionError &&
        ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"].includes(error.code)
      ) {
        assertLive();
        state.status = "disconnected";
        await this.store.write(state, assertLive);
        assertLive();
      }
      throw error;
    }
    if (pending.action === "begin") {
      state.pairingId = String(result.pairingId);
      state.pairingExpiresAt = String(result.expiresAt);
    }
    if (pending.action === "exchange" || pending.action === "rotate") {
      state.credential = pending.candidateCredential;
      state.deviceId = String(result.deviceId);
      state.credentialExpiresAt = String(result.expiresAt);
      state.status = "connected";
      delete state.code;
      delete state.proof;
    }
    if (pending.action === "workspace" && state.registration && pending.candidate)
      state.registration.mapping = {
        ...pending.candidate,
        workspaceId: String(result.workspaceId),
      };
    if (pending.action === "agent" || pending.action === "replace") {
      const mapping = {
        ...pending.candidate!,
        workspaceId: String(result.workspaceId),
        agentId: String(result.agentId),
        bindingEpoch: Number(result.bindingEpoch),
      };
      const index = state.mappings.findIndex((m) => m.agentId === mapping.agentId);
      if (index < 0) state.mappings.push(mapping);
      else state.mappings[index] = mapping;
      delete state.registration;
    }
    assertLive();
    delete state.pending;
    await this.store.write(state, assertLive);
    assertLive();
    return result;
  }
  async pair(deviceAlias: string) {
    let state = await this.store.read();
    if (state) {
      if (
        state.server !== this.client.origin ||
        (state.pending && state.pending.action !== "begin") ||
        state.credential
      )
        throw new ConnectionError("CONFLICT");
      if (state.pending) await this.send(state);
      if (!state.code || !state.pairingId) throw new ConnectionError("CONFLICT");
      return { state: state.status, code: state.code, expiresAt: state.pairingExpiresAt };
    }
    const code = randomBytes(32).toString("hex"),
      proof = randomBytes(32).toString("hex");
    const body = validateBody("begin", {
      codeHash: hash(code),
      proofHash: hash(proof),
      deviceAlias,
      protocol: 1,
    });
    state = {
      version: 1,
      server: this.client.origin,
      status: "pairing",
      code,
      proof,
      mappings: [],
    };
    await this.journal(state, "begin", body);
    await this.send(state);
    return { state: "pairing", code, expiresAt: state.pairingExpiresAt };
  }
  async status() {
    const state = await this.state();
    if (state.pending?.action === "begin")
      return {
        state: state.status,
        pending: "begin",
        recovery:
          "remove this local profile with revoke-local, then pair again and obtain fresh approval",
      };
    if (state.pending)
      return {
        state: state.status,
        pending: state.pending.action,
        recovery: "retry the same command",
      };
    if (state.status === "pairing" && state.pairingId && state.proof) {
      const result = await this.client.call(
        "pairing-status",
        { pairingId: state.pairingId },
        state.proof,
      );
      if (result.state === "approved") {
        state.scope = result.scope as Scope;
        await this.store.write(state);
      }
      return result;
    }
    if (
      state.status !== "connected" ||
      !state.credential ||
      Date.parse(state.credentialExpiresAt ?? "") <= Date.now()
    ) {
      state.status = "disconnected";
      await this.store.write(state);
      return { state: "disconnected", recovery: "fresh approval required" };
    }
    try {
      const result = await this.client.call("bindings", {}, state.credential);
      return {
        state: "registered",
        verification: "unverified",
        scope: state.scope,
        bindings: result.bindings,
      };
    } catch (error) {
      if (
        error instanceof ConnectionError &&
        ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
      ) {
        state.status = "disconnected";
        await this.store.write(state);
        return { state: "disconnected", recovery: "fresh approval required" };
      }
      throw error;
    }
  }
  async exchange(confirmedRoomId: string) {
    const state = await this.state();
    if (state.pending) {
      if (state.pending.action !== "exchange" || state.scope?.roomId !== confirmedRoomId)
        throw new ConnectionError("CONFLICT");
      return this.send(state);
    }
    if (
      state.status !== "pairing" ||
      !state.proof ||
      !state.pairingId ||
      state.scope?.roomId !== confirmedRoomId
    )
      throw new ConnectionError("CONFLICT");
    const credential = randomBytes(32).toString("hex");
    await this.journal(
      state,
      "exchange",
      {
        pairingId: state.pairingId,
        operationId: randomUUID(),
        credentialHash: hash(credential),
        confirmed: true,
      },
      state.proof,
      credential,
    );
    return this.send(state);
  }
  async rotate(assertLive = () => {}) {
    const state = await this.state();
    assertLive();
    if (state.pending) {
      if (state.pending.action !== "rotate") throw new ConnectionError("CONFLICT");
      return this.send(state, assertLive);
    }
    this.usable(state);
    const credential = randomBytes(32).toString("hex");
    await this.journal(
      state,
      "rotate",
      { operationId: randomUUID(), credentialHash: hash(credential) },
      state.credential,
      credential,
      undefined,
      assertLive,
    );
    assertLive();
    return this.send(state, assertLive);
  }
  async register(input: {
    root: string;
    nativeSessionId: string;
    repositoryAlias: string;
    sessionAlias: string;
    confirmed: boolean;
  }) {
    const state = await this.state();
    if (!input.confirmed) throw new ConnectionError("INVALID_BODY");
    if (state.pending) {
      if (!["workspace", "agent"].includes(state.pending.action))
        throw new ConnectionError("CONFLICT");
      const prior = state.pending.action;
      const result = await this.send(state);
      if (prior === "agent") return result;
    }
    if (!state.registration) {
      this.usable(state);
      const root = await canonicalRoot(input.root);
      const body = workspaceBody(randomUUID(), {
        repositoryAlias: input.repositoryAlias,
        ...(await gitMetadata(root)),
      });
      agentBody(randomUUID(), randomUUID(), { sessionAlias: input.sessionAlias, runtime: "codex" });
      state.registration = {
        mapping: { root, nativeSessionId: input.nativeSessionId },
        sessionAlias: input.sessionAlias,
      };
      await this.journal(
        state,
        "workspace",
        body,
        state.credential,
        undefined,
        state.registration.mapping,
      );
      await this.send(state);
    }
    if (state.registration) {
      if (
        state.status !== "connected" ||
        !state.credential ||
        !state.registration.mapping.workspaceId
      )
        throw new ConnectionError("CONFLICT");
      await this.journal(
        state,
        "agent",
        agentBody(randomUUID(), state.registration.mapping.workspaceId, {
          sessionAlias: state.registration.sessionAlias,
          runtime: "codex",
        }),
        state.credential,
        undefined,
        state.registration.mapping,
      );
      return this.send(state);
    }
    return { state: "registered", verification: "unverified" };
  }
  async replace(input: {
    agentId: string;
    root: string;
    nativeSessionId: string;
    repositoryAlias: string;
    sessionAlias: string;
    confirmed: boolean;
    operationId?: string;
    metadata?: WorkspaceMetadata;
    assertLive?: () => void;
  }) {
    const check = input.assertLive ?? (() => {});
    const state = await this.state();
    check();
    if (!input.confirmed) throw new ConnectionError("INVALID_BODY");
    if (state.pending) {
      if (
        state.pending.action !== "replace" ||
        state.pending.body.agentId !== input.agentId ||
        (input.operationId && state.pending.body.operationId !== input.operationId)
      )
        throw new ConnectionError("CONFLICT");
      return this.send(state, check);
    }
    this.usable(state);
    const old = state.mappings.find((m) => m.agentId === input.agentId);
    if (!old) throw new ConnectionError("NOT_FOUND");
    const root = await canonicalRoot(input.root);
    check();
    const metadata = input.metadata ?? (await gitMetadata(root));
    check();
    const body = validateBody("replace", {
      operationId: input.operationId ?? randomUUID(),
      agentId: input.agentId,
      expectedEpoch: old.bindingEpoch!,
      repositoryAlias: input.repositoryAlias,
      ...metadata,
      sessionAlias: input.sessionAlias,
      runtime: "codex",
    });
    await this.journal(
      state,
      "replace",
      body,
      state.credential,
      undefined,
      { ...old, root, nativeSessionId: input.nativeSessionId },
      check,
    );
    check();
    return this.send(state, check);
  }
  async heartbeat() {
    const state = await this.state();
    this.usable(state);
    try {
      return await this.client.call("heartbeat", {}, state.credential);
    } catch (error) {
      if (
        error instanceof ConnectionError &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code)
      ) {
        state.status = "disconnected";
        await this.store.write(state);
      }
      throw error;
    }
  }
}
export async function main(args: string[]) {
  if (process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) !== 24)
    throw new ConnectionError("UNAVAILABLE");
  const [command, ...rest] = args;
  const options: Record<string, string> = {};
  const allowed = new Set([
    "server",
    "state-dir",
    "profile",
    "device-alias",
    "confirm-scope",
    "root",
    "native-session",
    "repository-alias",
    "session-alias",
    "agent-id",
    "confirm-public",
    "model",
    "effort",
    "runtime-default",
    "files",
    "handoff",
    "confirm-new-context",
    "confirm-auto-questions",
    "once",
  ]);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (
      !rest[i]?.startsWith("--") ||
      !allowed.has(key) ||
      !rest[i + 1] ||
      Object.hasOwn(options, key)
    )
      throw new ConnectionError("INVALID_BODY");
    options[key] = rest[i + 1];
  }
  const required = (key: string) => {
    if (!options[key]) throw new ConnectionError("INVALID_BODY");
    return options[key];
  };
  const store = new StateStore(
    options["state-dir"] ??
      join(homedir(), "Library", "Application Support", "ai-collab", "connector"),
    options.profile ?? "default",
  );
  const origin =
    options.server ??
    (command === "revoke-local"
      ? ((await store.read())?.server ?? "http://127.0.0.1")
      : required("server"));
  const client = new CentralClient(origin),
    connector = new Connector(store, client);
  const runner = (agentId: string) =>
    new WorkflowRunner(
      store,
      new RuntimeStore(store.dir, store.profile, agentId),
      new WorkflowClient(client.origin),
      new CodexAdapter(),
      {
        rotate: (check) => connector.rotate(check),
        bindings: async (credential) =>
          (await client.call("bindings", {}, credential)).bindings as PublicBinding[],
        replace: (input) => connector.replace(input),
      },
    );
  let result: unknown;
  if (command?.startsWith("runtime-")) {
    if (command === "runtime-capabilities") {
      const adapter = new CodexAdapter();
      try {
        const policy = await RuntimeFilePolicy.select(required("root"), []);
        const capabilities = await adapter.capabilities(policy.root.path, () => {});
        result = {
          provider: "codex",
          version: capabilities.version,
          models: capabilities.models,
          defaultSettings: capabilities.defaultSettings,
          policy: capabilities.policy,
          accountEligibility: "UNVERIFIED",
          finalInputIsolation: "UNVERIFIED",
        };
      } finally {
        await adapter.close();
      }
    } else {
      const runtime = runner(required("agent-id"));
      if (command === "runtime-status") result = await runtime.status();
      else if (command === "runtime-prepare") {
        if (options["confirm-new-context"] !== "yes" || options["confirm-public"] !== "yes")
          throw new ConnectionError("INVALID_BODY");
        if (options["runtime-default"] === "yes" && (options.model || options.effort))
          throw new ConnectionError("INVALID_BODY");
        const choice =
          options["runtime-default"] === "yes"
            ? ("default" as const)
            : { model: required("model"), effort: required("effort") };
        let files: unknown;
        try {
          files = JSON.parse(options.files ?? "[]");
        } catch {
          throw new ConnectionError("INVALID_BODY");
        }
        if (!Array.isArray(files) || !files.every((p) => typeof p === "string"))
          throw new ConnectionError("INVALID_BODY");
        result = await runtime.prepare({
          root: options.root,
          choice,
          files,
          handoff: options.handoff ?? "",
          confirmed: true,
          autoQuestionsConfirmed: options["confirm-auto-questions"] === "yes",
        });
      } else if (command === "runtime-run") {
        const cancellation = new AbortController();
        const stop = () => cancellation.abort();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        try {
          result = await runtime.run({ once: options.once === "yes", signal: cancellation.signal });
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }
      } else if (command === "runtime-observe") result = await runtime.observe();
      else throw new ConnectionError("INVALID_BODY");
    }
  } else if (command === "revoke-local") {
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
    result = await remove(0);
  } else if (command === "replace") {
    const agentId = required("agent-id");
    result = await runner(agentId).guardMutation(() =>
      store.transaction(() =>
        connector.replace({
          agentId,
          root: required("root"),
          nativeSessionId: required("native-session"),
          repositoryAlias: required("repository-alias"),
          sessionAlias: required("session-alias"),
          confirmed: options["confirm-public"] === "yes",
        }),
      ),
    );
  } else
    result = await store.transaction(async () => {
      if (command === "pair") return connector.pair(required("device-alias"));
      if (command === "status") return connector.status();
      if (command === "exchange") return connector.exchange(required("confirm-scope"));
      if (command === "rotate") return connector.rotate();
      if (command === "heartbeat") return connector.heartbeat();
      if (command === "register")
        return connector.register({
          root: required("root"),
          nativeSessionId: required("native-session"),
          repositoryAlias: required("repository-alias"),
          sessionAlias: required("session-alias"),
          confirmed: options["confirm-public"] === "yes",
        });
      throw new ConnectionError("INVALID_BODY");
    });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      JSON.stringify({
        state: "disconnected",
        error:
          error instanceof ConnectionError || error instanceof RuntimeError
            ? error.code
            : "UNAVAILABLE",
      }) + "\n",
    );
    process.exitCode = 1;
  });

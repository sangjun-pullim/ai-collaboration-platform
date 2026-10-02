import { randomBytes } from "node:crypto";
import { StateStore } from "../src/state-store.ts";
import { WorkflowClient } from "../src/workflow-client.ts";
import { CentralClient } from "../src/central-client.ts";
import { Connector } from "../src/cli.ts";
import { WorkflowRunner, type RunnerOptions } from "../src/workflow-runner.ts";
import { RuntimeError, digest, stableJson, type AttemptAuthority, type OwnedContext, type RuntimeAdapter, type RuntimeSettings, type RootIdentity, type TerminalEvidence } from "../src/runtime-contracts.ts";
import { validateBody, type AttemptSnapshot, type Body, type Control, type DeviceAction, type PollSnapshot, type RequestPayload } from "../src/workflow-contracts.ts";
import type { PublicBinding } from "../src/contracts.ts";
import { runtimeFixture, capabilities, observation, uuid } from "./runtime-fixture.ts";
export function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
/** Move a synthetic wall clock only after finite writes/readiness jobs at the current instant settle. */
export async function settleRunnerJobs(runner: WorkflowRunner) {
  const jobs = runner as unknown as { mutations: Promise<unknown>; readyWork?: Promise<void> };
  await jobs.mutations; await jobs.readyWork; await jobs.mutations;
}
export class SyntheticAdapter implements RuntimeAdapter {
  starts = 0; prepares = 0; validates = 0; interrupts = 0; closed = false;
  current?: AttemptAuthority;
  executeHook?: (authority: AttemptAuthority) => Promise<void>;
  validateHook?: () => Promise<void>;
  prepareHook?: () => Promise<void>;
  observed: TerminalEvidence | null = null;
  terminal: "COMPLETED" | "FAILED" | "INTERRUPTED" = "COMPLETED";
  async capabilities(_root: string, check: () => void) { check(); return capabilities(); }
  async prepare(root: RootIdentity, _settings: RuntimeSettings, generation: string, epoch: number, check: () => void, onCreated: (context: OwnedContext) => Promise<void> = async () => {}): Promise<OwnedContext> {
    this.prepares++; await this.prepareHook?.(); check(); const context: OwnedContext = { ownership: "CONNECTOR_CREATED", root, generation, epoch, threadId: uuid(), level: "L1", ownedTurns: [] };
    await onCreated(structuredClone(context)); check(); return context;
  }
  async validate(_context: OwnedContext, settings: RuntimeSettings, check: () => void) { this.validates++; await this.validateHook?.(); check(); return observation(settings); }
  async execute(authority: AttemptAuthority, settings: RuntimeSettings, _payload: RequestPayload, beforeSubmit: () => Promise<void>) {
    this.current = authority; await this.validate(authority.context, settings, () => authority.assertLive()); await beforeSubmit(); authority.assertLive(); this.starts++;
    const turnId = uuid(); await authority.ack(authority.context.threadId, turnId); authority.assertLive();
    await this.executeHook?.(authority); authority.assertLive();
    const evidence: TerminalEvidence = { threadId: authority.context.threadId, turnId, terminal: this.terminal, privateText: "Selected public conclusion.", publicText: "", finalItems: [{ id: "final", hash: digest("Selected public conclusion.") }], textProof: "FINAL_ANSWER", observation: observation(settings) };
    this.observed = evidence; return evidence;
  }
  async interrupt() { this.interrupts++; return true; }
  async observe(_context: OwnedContext, _settings: RuntimeSettings, _native: { threadId: string; turnId: string }, check: () => void) { check(); return this.observed; }
  async close() { this.closed = true; }
}
export async function runnerFixture(options: RunnerOptions = {}) {
  const f = await runtimeFixture(); let currentCredential = randomBytes(32).toString("hex"); let currentHash = digest(currentCredential);
  const oldKeys = new Set<string>(); const requests: { action: string; body: Body; secret: string }[] = [];
  const receipts = new Map<string, { key: string; result: unknown }>(); const connectorReceipts = new Map<string, { key: string; result: unknown }>();
  let queued: RequestPayload | null = null, attempt: AttemptSnapshot | null = null, control: Control | null = null, roomMode: "ACTIVE" | "PAUSING" | "PAUSED" = "ACTIVE", epoch = 1;
  const attempts = new Map<string, AttemptSnapshot>(); let fence = 0;
  let questionCount = 0; const faults = { before: undefined as ((action: string, body: Body, secret: string) => Promise<void>) | undefined, after: undefined as ((action: string, body: Body, result: unknown, response: { destroy(): void }) => Promise<boolean | void>) | undefined, revoked: false };
  const profile = new StateStore(f.stateDir, "one"); const workspaceId = uuid();
  const binding = (): PublicBinding => ({ workspaceId, agentId: f.scope.agentId, bindingEpoch: epoch, ownerAlias: "Synthetic owner", deviceAlias: "Synthetic device", repositoryAlias: "Synthetic repository", sessionAlias: "Synthetic session", runtime: "codex", branch: "unknown", commit: "unknown", dirty: "unknown", state: "registered", verification: "unverified", lastSeenAt: null });
  const poll = (): PollSnapshot => ({ roomId: f.scope.roomId, roomRevision: 1, roomMode, agentId: f.scope.agentId, bindingEpoch: epoch, reportedReady: true, validUntil: new Date(Date.now() + 60000).toISOString(), queuedRequest: queued, attempt: attempt?.state === "ABANDONED" ? null : attempt, control });
  const origin = "http://127.0.0.1:7777";
  const fetcher: typeof fetch = async (url, init) => {
    if (!String(url).startsWith(origin+"/api/") || init?.method!=="POST") throw new RuntimeError("INVALID_RUNTIME");
    const fail=(status:number,code:string)=>new Response(JSON.stringify({ok:false,error:{code}}),{status,headers:{"Content-Type":"application/json"}});
    const input=JSON.parse(String(init.body)) as Body, secret=new Headers(init.headers).get("Authorization")!.slice(7), action=String(url).split("/").at(-1)!;
    let destroyed=false; const response={destroy(){destroyed=true;}};
    try {
      requests.push({ action, body: structuredClone(input), secret }); await faults.before?.(action, input, secret);
      if (faults.revoked) { return fail(403, "FORBIDDEN"); }
      const connectorAction = String(url).startsWith(origin+"/api/connector/");
      if (digest(secret) !== currentHash && !(connectorAction && action === "rotate" && oldKeys.has(digest(secret)) && connectorReceipts.has(String(input.operationId)))) { return fail(401, "UNAUTHENTICATED"); }
      let result: unknown;
      if (connectorAction) {
        if (action === "bindings") result = { protocol: 1, bindings: [binding()] };
        else {
          const key = stableJson({ action, input }); const prior = connectorReceipts.get(String(input.operationId));
          if (prior) { if (prior.key !== key) throw new RuntimeError("INVALID_RUNTIME"); result = prior.result; }
          else {
            if (action === "rotate") { oldKeys.add(currentHash); currentHash = String(input.credentialHash); result = { protocol: 1, deviceId: f.scope.deviceId, expiresAt: new Date(Date.now() + 600000).toISOString() }; }
            else if (action === "replace") { if (input.expectedEpoch !== epoch) { return fail(409, "CONFLICT"); } epoch++; result = { protocol: 1, agentId: f.scope.agentId, workspaceId, bindingEpoch: epoch, state: "registered", verification: "unverified" }; }
            else throw new RuntimeError("INVALID_RUNTIME");
            connectorReceipts.set(String(input.operationId), { key, result });
          }
        }
      } else {
        const body = validateBody(action as DeviceAction, input); if (body.agentId !== f.scope.agentId || body.bindingEpoch !== epoch) { return fail(409, "CONFLICT"); }
        const key = stableJson({ action, body }); const prior = receipts.get(String(body.operationId));
        if (prior && action !== "poll") { if (prior.key !== key) throw new RuntimeError("INVALID_RUNTIME"); result = action === "claim" ? structuredClone(attempts.get((prior.result as AttemptSnapshot).attemptId)) : prior.result; }
        else {
          if (action === "poll") result = poll();
          else if (action === "ready") result = { agentId: f.scope.agentId, bindingEpoch: epoch, reportedReady: body.reportedReady, validUntil: body.reportedReady ? new Date(Date.now() + 60000).toISOString() : null, verification: "reported" };
          else if (action === "claim") {
            if (!queued || body.requestId !== queued.requestId || attempt && ["LEASED", "EXECUTING", "UNKNOWN"].includes(attempt.state)) { return fail(409, "CONFLICT"); }
            attempt = { requestId: queued.requestId, attemptId: uuid(), agentId: f.scope.agentId, bindingEpoch: epoch, fence: ++fence, state: "LEASED", leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), startIntentAt: null, payload: queued }; attempts.set(attempt.attemptId, attempt); queued = null; result = structuredClone(attempt);
          } else {
            if (!attempt || body.attemptId !== attempt.attemptId || body.requestId !== attempt.requestId || body.fence !== attempt.fence) { return fail(409, "CONFLICT"); }
            if (action === "start-intent") { if (!["LEASED", "EXECUTING"].includes(attempt.state)) return fail(409, "CONFLICT"); attempt.state = "EXECUTING"; attempt.startIntentAt = new Date().toISOString(); result = structuredClone(attempt); }
            else if (action === "lease") { if (!["LEASED", "EXECUTING"].includes(attempt.state)) return fail(409, "CONFLICT"); attempt.leaseExpiresAt = new Date(Date.now() + 30000).toISOString(); result = structuredClone(attempt); }
            else if (action === "question") { questionCount++; result = { cycleId: attempt.payload.cycleId, questionId: uuid(), peerRequestId: uuid(), accepted: true, cycleState: "ACTIVE" }; }
            else if (action === "complete" || action === "observe") { attempt.state = body.terminal as "COMPLETED"; result = { requestId: attempt.requestId, attemptId: attempt.attemptId, terminal: body.terminal, adoption: "ACCEPTED", continuationRequestId: null }; }
            else if (action === "interrupt-ack") { if (!control || body.controlId !== control.controlId) throw new RuntimeError("INVALID_RUNTIME"); control.state = "ACKNOWLEDGED"; result = structuredClone(control); }
            else throw new RuntimeError("INVALID_RUNTIME");
          }
          if (action !== "poll") receipts.set(String(body.operationId), { key, result: structuredClone(result) });
        }
      }
      await faults.after?.(action, input, result, response);
      if(destroyed) return Response.error();
      return new Response(JSON.stringify({ok:true,data:result}),{status:200,headers:{"Content-Type":"application/json"}});
    } catch { return fail(503,"UNAVAILABLE"); }
  };
  f.scope.server = origin; f.record.scope.server = origin;
  await profile.write({ version: 1, server: origin, status: "connected", credential: currentCredential, credentialExpiresAt: new Date(Date.now() + 600000).toISOString(), deviceId: f.scope.deviceId, scope: { ownerAlias: "Synthetic owner", organizationId: f.scope.organizationId, organizationName: "Synthetic organization", roomId: f.scope.roomId, roomTitle: "Synthetic room", deviceAlias: "Synthetic device" }, mappings: [{ root: f.root, nativeSessionId: f.context.threadId, workspaceId, agentId: f.scope.agentId, bindingEpoch: 1 }] });
  await f.store.write(f.record); const central = new CentralClient(origin,fetcher), connector = new Connector(profile, central);
  const connections = { rotate: (check?: () => void) => connector.rotate(check), bindings: async (credential: string) => (await central.call("bindings", {}, credential)).bindings as PublicBinding[], replace: (input: Parameters<Connector["replace"]>[0]) => connector.replace(input) };
  const adapter = new SyntheticAdapter(); const runner = (customAdapter: RuntimeAdapter = adapter, customOptions: RunnerOptions = options) => new WorkflowRunner(profile, f.store, new WorkflowClient(origin,fetcher), customAdapter, connections, customOptions);
  return { ...f, profile, connector, adapter, runner, connections, requests, faults,
    queue: (kind: RequestPayload["requestKind"] = "ORIGIN") => { if (attempt && ["LEASED", "EXECUTING", "UNKNOWN"].includes(attempt.state)) throw new RuntimeError("RUNTIME_BUSY"); queued = { requestId: uuid(), cycleId: uuid(), agentId: f.scope.agentId, bindingEpoch: epoch, roomRevision: 1, requestKind: kind, questionId: kind === "PEER" || kind === "CONTINUATION" ? uuid() : null, publicText: "Synthetic public investigation", replyText: kind === "CONTINUATION" ? "Synthetic peer answer" : null, deadline: new Date(Date.now() + 120000).toISOString() }; return queued; },
    poll, questionCount: () => questionCount,
    expireUnstarted: () => { if (!attempt || attempt.state !== "LEASED" || attempt.startIntentAt !== null) throw new RuntimeError("INVALID_RUNTIME"); attempt.state = "ABANDONED"; attempt.leaseExpiresAt = new Date(Date.now() - 1000).toISOString(); queued = structuredClone(attempt.payload); },
    epoch: (value: number) => { epoch = value; },
    control: () => { if (!attempt) throw new RuntimeError("UNKNOWN"); control = { controlId: uuid(), requestId: attempt.requestId, attemptId: attempt.attemptId, fence: attempt.fence, state: "REQUESTED" }; return control; },
    mode: (value: typeof roomMode) => { roomMode = value; },
    unknown: () => { if (attempt) { attempt.state = "UNKNOWN"; attempt.leaseExpiresAt = new Date(Date.now() - 1000).toISOString(); } },
    rotate: async () => { await profile.transaction(() => connector.rotate()); currentCredential = (await profile.read())!.credential!; return currentCredential; },
    close: async () => { await f.close(); },
  };
}

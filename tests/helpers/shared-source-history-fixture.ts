import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowFixture, WorkflowScene } from "./workflow-fixture.js";
import type { DeviceProfile, DeviceResponse } from "./device-binding-fixture.js";
import { assertOwnedStack, ensure } from "./local-access-stack.js";
import {
  validateBody,
  projectEnvelope,
  type Body,
  type DeviceAction,
  type SourceReadPage,
  type AttemptSnapshot,
} from "../../src/features/investigation-coordinator/contracts.ts";
import { type SourcePacket } from "../../src/features/investigation-coordinator/source-contracts.ts";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export { sourceFixtureManifest, sourceFixtureAutoManifest } from "./source-manifest-fixture.js";
import { sourceFixtureManifest } from "./source-manifest-fixture.js";
export function fixtureSourcePackets(bytes: Buffer, manifestHash: string): SourcePacket[] {
  const count = Math.ceil(bytes.length / 8192);
  return Array.from({ length: count }, (_, index) => {
    const chunk = bytes.subarray(index * 8192, (index + 1) * 8192);
    return {
      version: 2,
      index,
      count,
      totalBytes: bytes.length,
      manifestHash,
      chunkHash: hash(chunk),
      bytesBase64: chunk.toString("base64"),
    };
  });
}
/** Source packets and read-only queries never enter the general WorkflowFixture operation ledger. */
export async function sourceDevice(
  f: WorkflowFixture,
  p: DeviceProfile,
  action: Extract<DeviceAction, "source-support" | "source-upload" | "source-confirm">,
  fields: Body,
): Promise<DeviceResponse> {
  await assertOwnedStack(f.stack.config);
  ensure(
    f.devices.profiles.get(p.name) === p && p.roomId && f.rooms.has(p.roomId),
    "Exact owned source device required",
  );
  const body = validateBody(action, {
    protocol: 1,
    agentId: p.agentId!,
    bindingEpoch: await f.epoch(p),
    ...fields,
  });
  const response = await fetch(`${f.stack.config.app}/api/workflow/${action}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.credential}` },
      body: JSON.stringify(body),
    }),
    text = await response.text(),
    data = JSON.parse(text);
  if (response.status === 200) {
    assert.ok(Buffer.byteLength(text) <= 16384);
    projectEnvelope(action, data, response.status);
  }
  return { status: response.status, headers: response.headers, text, data };
}
export async function sourceRead(
  f: WorkflowFixture,
  s: WorkflowScene,
  eventId: string,
  afterIndex: number | null = null,
  person = s.owner,
): Promise<SourceReadPage> {
  await assertOwnedStack(f.stack.config);
  ensure(
    f.stack.users.has(person.id) && f.rooms.get(s.scope.roomId) === s.scope.organizationId,
    "Exact owned source reader required",
  );
  const body = validateBody("source-read", {
      protocol: 1,
      roomId: s.scope.roomId,
      eventId,
      afterIndex,
    }),
    response = await person.web.post("/api/investigations/source-read", body),
    text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(text) <= 16384);
  return projectEnvelope("source-read", JSON.parse(text), 200) as SourceReadPage;
}
export const sourceAttemptIdentity = (a: AttemptSnapshot): Body => ({
  requestId: a.requestId,
  attemptId: a.attemptId,
  fence: a.fence,
});
export async function uploadFixtureSource(
  f: WorkflowFixture,
  s: WorkflowScene,
  a: AttemptSnapshot,
  source = sourceFixtureManifest(["src/input.ts"]),
) {
  const packets = fixtureSourcePackets(source.bytes, source.manifestHash),
    identity = sourceAttemptIdentity(a),
    operations = packets.map(() => randomUUID());
  for (const packet of packets)
    assert.equal(
      (
        await sourceDevice(f, s.origin, "source-upload", {
          ...identity,
          operationId: operations[packet.index],
          packetJson: JSON.stringify(packet),
        })
      ).status,
      200,
    );
  const confirm = await sourceDevice(f, s.origin, "source-confirm", {
    ...identity,
    manifestHash: source.manifestHash,
  });
  assert.equal(confirm.status, 200);
  assert.equal((confirm.data.data as { state: string }).state, "CONFIRMED");
  return { source, packets, operations };
}
/** Explicit warm driver for an existing owned 001–012 stack. No reset/bootstrap/reapplication. */
export async function upgradeSharedSourceHistory(f: WorkflowFixture) {
  await assertOwnedStack(f.stack.config);
  const preconditions = async () => {
    const row = (
      await f.stack.db.query(
        "select to_regnamespace('source_history_private') is null absent, to_regprocedure('public.workflow_device_admission(jsonb,text)') is not null previous, position('readMode' in pg_get_functiondef('runtime_settings_private.validate(text,jsonb)'::regprocedure))>0 repository, pg_backend_pid() pid",
      )
    ).rows[0];
    ensure(
      row.absent && row.previous && row.repository,
      "Only exact owned 001–012 upgrade is permitted",
    );
    return row.pid;
  };
  const pid = await preconditions(),
    s = await f.scene("source-warm-upgrade"),
    admission = await f.start(s),
    attempt = await f.run(s.origin, admission.requestId!),
    receipt = await f.complete(s.origin, attempt),
    history = await f.history(s);
  assert.equal(await preconditions(), pid);
  await f.stack.db.query(
    await readFile(
      resolve("supabase/migrations/20261006001300-shared-input-source-history.sql"),
      "utf8",
    ),
  );
  assert.deepEqual(await f.history(s), history);
  const restored = (
    await f.stack.db.query("select workflow_private.restore('complete',$1::jsonb) receipt", [
      JSON.stringify(receipt),
    ])
  ).rows[0].receipt;
  assert.deepEqual(restored, receipt);
  const targets = await f.stack.db.query(
    "select count(*)::integer count from source_history_private.targets where room_id=$1",
    [s.scope.roomId],
  );
  assert.equal(targets.rows[0].count, 0);
  for (const event of history.events.filter((e) => e.requestId === attempt.requestId))
    assert.equal((await sourceRead(f, s, event.eventId)).state, "NO_TARGET_SNAPSHOT");
}

/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DeviceFixture, type DeviceProfile } from "../helpers/device-binding-fixture.ts";
import type { FixturePerson, LocalAccessStack } from "../helpers/local-access-stack.ts";
import { WorkflowFixture } from "../helpers/workflow-fixture.ts";
import type { Body } from "../../src/features/investigation-coordinator/contracts.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "workflow-profile-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const people: FixturePerson[] = [];
  const joins: { person: FixturePerson; displayName: string }[] = [];
  const stack = {
    namespace: "workflow-profile-unit",
    config: { project: "ai-collab-txxcvm61", api: "mock-api", app: "mock-app" },
    users: new Set<string>(),
    organizationOwners: new Map<string, string>(),
    async person(label: string) {
      const person = { id: randomUUID(), displayName: label } as FixturePerson;
      people.push(person);
      this.users.add(person.id);
      return person;
    },
    async bootstrap(person: FixturePerson) {
      const scope = { organizationId: randomUUID(), roomId: randomUUID() };
      this.organizationOwners.set(scope.organizationId, person.id);
      return scope;
    },
    async invite() {
      return "mock-invitation";
    },
    async join(person: FixturePerson, _invitation: string, displayName: string) {
      joins.push({ person, displayName });
    },
  };
  const devices = Reflect.construct(DeviceFixture, [
    stack as unknown as LocalAccessStack,
    root,
  ]) as DeviceFixture;
  const connected: DeviceProfile[] = [];
  const registered: DeviceProfile[] = [];
  const ready: DeviceProfile[] = [];
  const cleaned: DeviceProfile[] = [];
  t.mock.method(
    devices,
    "connected",
    async (
      person: FixturePerson,
      scope: { organizationId: string; roomId: string },
      name: string,
    ) => {
      assert.match(name, /^[a-z0-9][a-z0-9-]{0,39}$/, "Strict pairing profile selector");
      assert.equal(devices.profiles.has(name), false, "Duplicate profile");
      assert.equal(devices.pairingIntents.has(name), false, "Duplicate pairing intent");
      const profile: DeviceProfile = {
        name,
        code: "mock-code",
        proof: "mock-proof",
        pairingId: randomUUID(),
        codeHash: "mock-code-hash",
        proofHash: "mock-proof-hash",
        deviceId: randomUUID(),
        agentId: randomUUID(),
        ownerUserId: person.id,
        ...scope,
      };
      devices.pairingIntents.set(name, { name, source: "cli", server: "mock-app" });
      devices.profiles.set(name, profile);
      connected.push(profile);
      await devices.saveCleanupIdentity();
      return profile;
    },
  );
  t.mock.method(devices, "register", async (profile: DeviceProfile) => {
    assert.equal(devices.profiles.get(profile.name), profile);
    registered.push(profile);
    return profile;
  });
  t.mock.method(devices, "close", async () => {
    for (const name of devices.pairingIntents.keys()) {
      const profile = devices.profiles.get(name);
      assert.ok(profile);
      cleaned.push(profile);
    }
    devices.pairingIntents.clear();
    devices.profiles.clear();
    await devices.saveCleanupIdentity();
  });
  const workflow = Reflect.construct(WorkflowFixture, [devices]) as WorkflowFixture;
  t.mock.method(workflow, "ready", async (profile: DeviceProfile) => {
    assert.equal(devices.profiles.get(profile.name), profile);
    ready.push(profile);
  });
  t.mock.method(workflow, "recoverOperations", async () => {});
  return { workflow, devices, root, people, joins, connected, registered, ready, cleaned };
}

test("should admit profiles for the three previously rejected workflow labels", async (t) => {
  for (const [method, label] of [
    ["directScene", "folder-REQUESTED"],
    ["scene", "settings-resumable-ACTIVE"],
    ["scene", "source-reject-peer-requested-lines"],
  ] as const) {
    await t.test(`should admit ${method} with ${label}`, async (t) => {
      const f = await fixture(t);
      await f.workflow[method](label);
      assert.ok(f.connected.length > 0);
      for (const profile of f.connected) assert.match(profile.name, /^[a-z0-9][a-z0-9-]{0,39}$/);
    });
  }
});

test("should preserve valid generated profile names byte for byte including the 40 character limit", async (t) => {
  for (const [method, label, roles] of [
    ["scene", "main", ["origin", "peer"]],
    ["directScene", "direct", ["responder"]],
    ["scene", "a".repeat(33), ["origin", "peer"]],
    ["directScene", "a".repeat(30), ["responder"]],
  ] as const) {
    await t.test(
      `should preserve ${method} profile bytes for label length ${label.length}`,
      async (t) => {
        const f = await fixture(t);
        await f.workflow[method](label);
        assert.deepEqual(
          f.connected.map((profile) => profile.name),
          roles.map((role) => `${label}-${role}`),
        );
        for (const profile of f.connected) assert.ok(Buffer.byteLength(profile.name) <= 40);
      },
    );
  }
});

test("should normalize only the invalid profile at the 41 character boundary", async (t) => {
  const f = await fixture(t);
  await f.workflow.scene("a".repeat(34));
  assert.equal(f.connected[0].name.length, 40);
  assert.notEqual(f.connected[0].name, `${"a".repeat(34)}-origin`);
  assert.equal(f.connected[1].name, `${"a".repeat(34)}-peer`);
  const direct = await fixture(t);
  await direct.workflow.directScene("a".repeat(31));
  assert.equal(direct.connected[0].name.length, 40);
  assert.notEqual(direct.connected[0].name, `${"a".repeat(31)}-responder`);
});

test("should derive stable names from the original case and keep case differences distinct", async (t) => {
  const first = await fixture(t);
  const repeat = await fixture(t);
  await first.workflow.directScene("folder-REQUESTED");
  await repeat.workflow.directScene("folder-REQUESTED");
  await first.workflow.directScene("folder-Requested");
  assert.equal(first.connected[0].name, repeat.connected[0].name);
  assert.equal(first.connected[0].name, "folder-requeste-f369bbb35ffc63618307d501");
  assert.notEqual(first.connected[0].name, first.connected[1].name);
  assert.equal(first.connected[0].name.slice(0, 15), first.connected[1].name.slice(0, 15));
});

test("should distinguish long names with an identical truncated stem and different roles", async (t) => {
  const f = await fixture(t);
  const prefix = `source-${"a".repeat(80)}`;
  await f.workflow.scene(`${prefix}-one`);
  await f.workflow.scene(`${prefix}-two`);
  const names = f.connected.map((profile) => profile.name);
  assert.equal(new Set(names).size, 4);
  assert.equal(new Set(names.map((name) => name.slice(0, 15))).size, 1);
  for (const name of names) {
    assert.equal(name.length, 40);
    assert.match(name, /^[a-z0-9][a-z0-9-]{0,39}$/);
  }
});

test("should constrain unsafe stems while retaining user labels and membership display names", async (t) => {
  for (const method of ["scene", "directScene"] as const) {
    await t.test(`should retain display labels for ${method}`, async (t) => {
      const f = await fixture(t);
      const label = "---한글 / PRIVATE_!";
      const scene = await f.workflow[method](label);
      const roles =
        method === "scene"
          ? ["owner", "peer", "observer", "outsider"]
          : ["owner", "requester", "observer", "outsider"];
      assert.deepEqual(
        f.people.map((person) => person.displayName),
        roles.map((role) => `${label}-${role}`),
      );
      assert.equal(f.joins[0].displayName, "질문 참가자");
      assert.equal(f.joins[1].displayName, "관찰자");
      assert.equal(f.workflow.rooms.get(scene.scope.roomId), scene.scope.organizationId);
      for (const profile of f.connected) {
        assert.match(profile.name, /^[a-z0-9][a-z0-9-]{0,39}$/);
        assert.ok(Buffer.byteLength(profile.name) <= 40);
      }
    });
  }
});

test("should reuse the returned profile objects in registration readiness and cleanup journals", async (t) => {
  for (const method of ["scene", "directScene"] as const) {
    await t.test(`should retain exact profile references for ${method}`, async (t) => {
      const f = await fixture(t);
      const scene = await f.workflow[method]("source-reject-peer-requested-lines");
      const profiles = "origin" in scene ? [scene.origin, scene.responder] : [scene.responder];
      await f.workflow.save();
      const workflowJournal = JSON.parse(
        await readFile(join(f.root, "workflow-identity.json"), "utf8"),
      );
      const deviceJournal = JSON.parse(
        await readFile(join(f.root, "cleanup-identity.json"), "utf8"),
      );
      for (const [index, profile] of profiles.entries()) {
        assert.equal(f.connected[index], profile);
        assert.equal(f.registered[index], profile);
        assert.equal(f.ready[index], profile);
        assert.equal(f.devices.profiles.get(profile.name), profile);
        assert.equal(f.devices.pairingIntents.get(profile.name)?.name, profile.name);
        assert.deepEqual(workflowJournal.bindings[index], {
          name: profile.name,
          deviceId: profile.deviceId,
          agentId: profile.agentId,
          ownerUserId: profile.ownerUserId,
          roomId: profile.roomId,
        });
        assert.equal(deviceJournal.pairings[index].name, profile.name);
        assert.equal(deviceJournal.pairings[index].profileFile, `state/${profile.name}.json`);
        assert.equal(deviceJournal.pairings[index].deviceId, profile.deviceId);
      }
      await f.workflow.close();
      for (const [index, profile] of profiles.entries()) assert.equal(f.cleaned[index], profile);
      assert.equal(f.devices.profiles.size, 0);
      assert.equal(f.devices.pairingIntents.size, 0);
    });
  }
});

test("should omit receipt recovery operations for device APIs without operationId", async (t) => {
  for (const action of ["source-support", "source-confirm"] as const) {
    await t.test(
      `should retain cleanup ownership without a ${action} receipt operation`,
      async (t) => {
        const f = await fixture(t);
        const scene = await f.workflow.scene();
        t.mock.method(f.workflow, "epoch", async () => 1);
        const saved = t.mock.method(f.workflow, "save", async () => {});
        const http = t.mock.method(
          globalThis,
          "fetch",
          async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            assert.equal(Object.hasOwn(body, "operationId"), false);
            return Response.json({ ok: false, error: { code: "UNAVAILABLE" } }, { status: 503 });
          },
        );
        const fields: Body =
          action === "source-support"
            ? {}
            : {
                requestId: randomUUID(),
                attemptId: randomUUID(),
                fence: 1,
                manifestHash: "a".repeat(64),
              };
        assert.equal((await f.workflow.device(scene.responder, action, fields)).status, 503);
        assert.deepEqual(f.workflow.operations, []);
        assert.equal(f.devices.profiles.get(scene.responder.name), scene.responder);
        assert.ok(f.devices.pairingIntents.has(scene.responder.name));
        assert.equal(saved.mock.callCount(), 1);
        assert.equal(http.mock.callCount(), 1);
      },
    );
  }
});

test("should retain exact UUID receipt operations for ordinary commands and source uploads", async (t) => {
  for (const action of ["ready", "source-upload"] as const) {
    await t.test(`should journal the validated ${action} operation unchanged`, async (t) => {
      const f = await fixture(t);
      const scene = await f.workflow.scene();
      t.mock.method(f.workflow, "epoch", async () => 1);
      t.mock.method(f.workflow, "save", async () => {});
      const operationId = randomUUID();
      const fields: Body =
        action === "ready"
          ? { operationId, reportedReady: true }
          : {
              operationId,
              requestId: randomUUID(),
              attemptId: randomUUID(),
              fence: 1,
              packetJson: JSON.stringify({
                version: 2,
                index: 0,
                count: 1,
                totalBytes: 1,
                manifestHash: "a".repeat(64),
                chunkHash: "a".repeat(64),
                bytesBase64: "YQ==",
              }),
            };
      const http = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.operationId, operationId);
        assert.equal(body.agentId, scene.responder.agentId);
        assert.equal(body.bindingEpoch, 1);
        return Response.json({ ok: false, error: { code: "UNAVAILABLE" } }, { status: 503 });
      });
      assert.equal((await f.workflow.device(scene.responder, action, fields)).status, 503);
      assert.deepEqual(f.workflow.operations, [
        {
          roomId: scene.scope.roomId,
          actorId: scene.responder.deviceId!,
          action,
          operationId,
        },
      ]);
      assert.equal(http.mock.callCount(), 1);
    });
  }
});

test("should reject an invalid operation UUID before receipt journaling or HTTP", async (t) => {
  const f = await fixture(t);
  const scene = await f.workflow.scene();
  t.mock.method(f.workflow, "epoch", async () => 1);
  t.mock.method(f.workflow, "save", async () => {});
  const http = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected HTTP"));
  await assert.rejects(
    f.workflow.device(scene.responder, "ready", {
      operationId: "undefined",
      reportedReady: true,
    }),
    { code: "INVALID_BODY" },
  );
  assert.equal(http.mock.callCount(), 0);
  assert.deepEqual(f.workflow.operations, []);
});

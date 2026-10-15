import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  connectionOrigin,
  connectionProfile,
  consumeConnectionFragment,
  localConnectionCommand,
  parseConnectionManifest,
  readConnectionSelection,
  nextConnectionSelection,
  connectionSelectionKey,
} from "../../src/features/device-binding/local-connection-command.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const manifest = () => ({
  version: 1,
  code: {
    path: `/local-connection/connector-${"a".repeat(64)}.tar.gz`,
    sha256: "a".repeat(64),
    bytes: 100,
  },
  bootstrap: {
    path: `/local-connection/bootstrap-${"b".repeat(64)}.sh`,
    sha256: "b".repeat(64),
    bytes: 100,
  },
});

test("should namespace profiles by user and room", async () => {
  const p = await connectionProfile("https://example.com", userId, roomId);
  assert.match(p, /^web-[a-f0-9]{32}$/);
  assert.equal(p, await connectionProfile("https://example.com", userId, roomId));
  assert.notEqual(p, await connectionProfile("https://example.com", organizationId, roomId));
  assert.notEqual(p, await connectionProfile("https://example.com", userId, organizationId));
  assert.notEqual(p, await connectionProfile("https://other.example.com", userId, roomId));
});

test("should carry a verified recovery generation while leaving the default profile unchanged", async () => {
  const base = await connectionProfile("https://example.com", userId, roomId);
  const recoveryId = "12345678-1234-4123-8123-123456789abc";
  const profile = `web-${createHash("sha256")
    .update(JSON.stringify(["connection-recovery", base, recoveryId]))
    .digest("hex")
    .slice(0, 32)}`;
  const input = {
    origin: "https://example.com",
    userId,
    roomId,
    organizationId,
    deviceAlias: "내 Mac",
    manifest: manifest(),
    selection: {
      version: 1,
      baseProfile: base,
      chain: [{ previousProfile: base, recoveryId, profile }],
    },
  };
  const command = await localConnectionCommand(input);
  assert.ok(command.includes(`'${profile}'`));
  assert.ok(command.includes(`'${base}'`));
  assert.ok(command.includes(`'${recoveryId}'`));
  await assert.rejects(localConnectionCommand({ ...input, roomId: organizationId }));
});

test("should carry every recovery ancestor when intermediate commands were never executed", async () => {
  const origin = "https://example.com";
  let selection = await readConnectionSelection(null, origin, userId, roomId);
  for (const suffix of ["abc", "abd", "abe"]) {
    selection = await nextConnectionSelection(
      selection,
      `12345678-1234-4123-8123-123456789${suffix}`,
    );
  }
  const command = await localConnectionCommand({
    origin,
    userId,
    roomId,
    organizationId,
    deviceAlias: "내 Mac",
    manifest: manifest(),
    selection,
  });
  assert.ok(
    command.includes(selection.baseProfile),
    "the original local record must remain reachable",
  );
  for (const generation of selection.chain) {
    assert.ok(command.includes(generation.profile));
    assert.ok(command.includes(generation.recoveryId));
  }
  assert.ok(
    command.includes(JSON.stringify(selection)),
    "the complete validated lineage must cross the shell boundary",
  );
});

test("should retain public recovery chains across refresh and reject foreign or altered selections", async () => {
  const origin = "https://example.com";
  const base = await readConnectionSelection(null, origin, userId, roomId);
  const first = await nextConnectionSelection(base, "12345678-1234-4123-8123-123456789abc");
  const raw = JSON.stringify(first);
  assert.deepEqual(await readConnectionSelection(raw, origin, userId, roomId), first);
  const second = await nextConnectionSelection(first, "12345678-1234-4123-8123-123456789abd");
  assert.equal(second.chain[1].previousProfile, first.chain[0].profile);
  assert.deepEqual(second.chain[0], first.chain[0]);
  for (const scope of [
    ["https://other.example", userId, roomId],
    [origin, organizationId, roomId],
    [origin, userId, organizationId],
  ])
    await assert.rejects(readConnectionSelection(raw, ...(scope as [string, string, string])));
  for (const bad of [
    "invalid",
    "null",
    JSON.stringify({ ...first, token: "private" }),
    JSON.stringify({ ...first, chain: [{ ...first.chain[0], profile: first.baseProfile }] }),
    JSON.stringify({ ...second, chain: [...second.chain].reverse() }),
    JSON.stringify({ ...first, chain: [{ ...first.chain[0], recoveryId: "not-uuid" }] }),
  ])
    await assert.rejects(readConnectionSelection(bad, origin, userId, roomId));
  assert.notEqual(
    connectionSelectionKey(origin, userId, roomId),
    connectionSelectionKey(origin, organizationId, roomId),
  );
  assert.notEqual(
    connectionSelectionKey(origin, userId, roomId),
    connectionSelectionKey(origin, userId, organizationId),
  );
  assert.ok(!Object.keys(first).some((key) => /token|native|path|credential/.test(key)));
});

test("should reject a foreign origin or unsafe manifest path", () => {
  for (const value of [
    "http://example.com",
    "https://name:secret@example.com",
    "https://example.com/",
    "https://example.com?code=secret",
    "https://example.com#code=secret",
  ])
    assert.throws(() => connectionOrigin(value));
  for (const path of [
    "https://foreign.example/bootstrap.sh",
    "/local-connection/../private.sh",
    "/local-connection/bootstrap.sh?token=secret",
  ]) {
    const value = manifest();
    value.bootstrap.path = path;
    assert.throws(() => parseConnectionManifest(value));
  }
});

test("should reject an invalid digest or unsupported manifest version", () => {
  const bad = manifest();
  bad.bootstrap.sha256 = "not-a-hash";
  assert.throws(() => parseConnectionManifest(bad));
  assert.throws(() => parseConnectionManifest({ ...manifest(), version: 2 }));
  assert.throws(() => parseConnectionManifest({ ...manifest(), extra: "private" }));
  const oversized = manifest();
  oversized.code.bytes = 16 * 1024 * 1024 + 1;
  assert.throws(() => parseConnectionManifest(oversized));
});

test("should quote Unicode and refuse hostile shell input without execution", async () => {
  const input = {
    origin: "https://example.com",
    userId,
    roomId,
    organizationId,
    deviceAlias: "내 Mac",
    manifest: manifest(),
  };
  const command = await localConnectionCommand(input);
  assert.ok(command.includes("'내 Mac'"));
  assert.ok(command.includes("--noprofile --norc -p"));
  for (const deviceAlias of [
    "Mac'; touch /tmp/marker",
    "$(touch /tmp/marker)",
    "Mac\ncommand",
    "Mac`command`",
  ])
    await assert.rejects(localConnectionCommand({ ...input, deviceAlias }));
  assert.ok(!command.includes(userId));
  assert.ok(!command.includes("--state-dir"));
  assert.ok(!command.includes("Authorization"));
  assert.ok(!command.includes("code="));
});

test("should consume only a valid fragment for an accessible room", () => {
  const code = "c".repeat(64);
  assert.deepEqual(consumeConnectionFragment(`#code=${code}&room=${roomId}`, [{ roomId }]), {
    code,
    roomId,
  });
  for (const hash of [
    `#code=${code}&room=${organizationId}`,
    `#code=short&room=${roomId}`,
    `#code=${code}&code=${code}&room=${roomId}`,
    `#code=${code}&room=${roomId}&auto=yes`,
  ])
    assert.equal(consumeConnectionFragment(hash, [{ roomId }]), null);
});

test("should keep short launch length invariant across recovery generations", async () => {
  let selection = await readConnectionSelection(null, "https://example.com", userId, roomId);
  const lengths: number[] = [];
  for (let n = 0; n <= 32; n++) {
    if ([0, 1, 10, 32].includes(n)) {
      const command = await localConnectionCommand({
        origin: "https://example.com",
        userId,
        roomId,
        organizationId,
        deviceAlias: "내 Mac",
        manifest: manifest(),
        selection,
        launch: { key: "c".repeat(64), payloadHash: "d".repeat(64) },
      });
      lengths.push(command.length);
      assert.ok(!command.includes(selection.baseProfile));
    }
    if (n < 32)
      selection = await nextConnectionSelection(
        selection,
        `12345678-1234-4123-8123-${String(n).padStart(12, "0")}`,
      );
  }
  assert.equal(new Set(lengths).size, 1);
});

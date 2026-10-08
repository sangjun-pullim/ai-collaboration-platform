import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionOrigin,
  connectionProfile,
  consumeConnectionFragment,
  localConnectionCommand,
  parseConnectionManifest,
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

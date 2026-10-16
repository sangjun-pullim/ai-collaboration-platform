import assert from "node:assert/strict";
import test from "node:test";
import type { SettingsManagerObservation } from "../src/settings/manager.ts";
import { uuid } from "./runtime-fixture.ts";

async function fixture() {
  const helper = new URL("../src/cli/settings-status.js", import.meta.url).href;
  const { createSettingsStatusSink } = await import(helper);
  const messages: string[] = [];
  const roomId = uuid();
  const sink: (status: SettingsManagerObservation) => void = createSettingsStatusSink({
    origin: "https://trusted.invalid",
    roomId,
    write: (message: string) => messages.push(message),
  });
  const status: SettingsManagerObservation = {
    state: "UNCONFIGURED",
    ready: false,
    reason: null,
    operationId: uuid(),
    configRevision: 0,
  };
  return { sink, messages, status, roomId };
}

test("should deduplicate actionable states independent of operation and revision and allow recurrence", async () => {
  const f = await fixture();
  f.sink(f.status);
  f.sink({ ...f.status, operationId: uuid(), configRevision: 9 });
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /AI.*폴더/);
  assert.ok(f.messages[0].includes(`https://trusted.invalid/app/connections?room=${f.roomId}`));
  f.sink({ ...f.status, state: "LOCAL_CONFIRMATION" });
  assert.match(f.messages[1], /모델.*effort.*적용/);
  f.sink(f.status);
  assert.equal(f.messages.length, 3);
  assert.equal(f.messages[0], f.messages[2]);
  assert.ok(!f.messages.join("").includes(f.status.operationId!));
});

test("should display setup completion independently of run readiness and prioritize errors", async () => {
  const f = await fixture();
  for (const state of [
    "APPLYING",
    "PREPARE_INTENT",
    "PREPARED",
    "COMMIT_INTENT",
    "COMMITTED",
    "LOCAL_COMMITTED",
  ])
    f.sink({ ...f.status, state });
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /준비 중/);
  f.sink({ ...f.status, state: "APPLIED", ready: false });
  assert.match(f.messages[1], /설정 적용 완료.*질문 가능한 상태.*웹 채팅방.*확인/);
  f.sink({ ...f.status, state: "APPLIED", ready: true });
  assert.equal(f.messages.length, 2, "a run result must not change the setup completion message");
  for (const reason of ["UNAUTHENTICATED", "FORBIDDEN"])
    f.sink({ ...f.status, state: "APPLIED", ready: true, reason });
  assert.equal(f.messages.length, 3, "401 and 403 have the same displayed action");
  assert.match(f.messages[2], /서버.*인증.*거부/);
  assert.match(f.messages[2], /웹.*연결.*확인/);
  assert.ok(!f.messages[2].includes("삭제"));
  assert.ok(!f.messages[2].includes("준비 완료"));
  f.sink({ ...f.status, state: "CANCELLED", ready: true });
  assert.match(f.messages[3], /취소/);
  assert.ok(!f.messages.join("").includes("준비 완료"));
});

test("should give safe actions for failures without echoing unknown error content", async () => {
  const f = await fixture();
  for (const reason of [
    "RUNTIME_BUSY",
    "PROVIDER_UNAVAILABLE",
    "SNAPSHOT_CHANGED",
    "CLEANUP_INCOMPLETE",
    "/private/sensitive/session-secret-token",
  ])
    f.sink({ ...f.status, state: "UNKNOWN", reason });
  assert.equal(f.messages.length, 5);
  assert.ok(f.messages.every((message) => message.includes("확인") || message.includes("선택")));
  assert.ok(!f.messages.join("").includes("session-secret-token"));
});

test("should report admission stages locally without leaking unknown stage text", async () => {
  const f = await fixture();
  for (const admissionStage of [
    "DOWNLOAD",
    "CACHE_INTEGRITY",
    "VERSION",
    "LOGIN",
    "PUBLISHER",
    "MANAGED_POLICY",
    "INSTALLATION",
  ] as const) {
    f.sink({ ...f.status, state: "FAILED", reason: "POLICY_UNCONFIRMED", admissionStage });
    assert.match(f.messages.at(-1)!, new RegExp(`CLAUDE_ADMISSION/${admissionStage}`));
  }
  const fault = {
    ...f.status,
    state: "FAILED",
    reason: "POLICY_UNCONFIRMED",
    admissionStage: "private-secret",
  };
  f.sink(fault as SettingsManagerObservation);
  assert.ok(!f.messages.join("").includes("private-secret"));
  f.sink({ ...f.status, state: "APPLIED" });
  assert.ok(!f.messages.at(-1)!.includes("CLAUDE_ADMISSION"));
});

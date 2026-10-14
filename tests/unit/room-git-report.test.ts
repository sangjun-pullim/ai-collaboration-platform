import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomBindings } from "../helpers/room-bindings-renderer.ts";
import { projectRoomGitBindings } from "../../src/features/device-binding/room-git-report.ts";
import { projectResponse } from "../../src/features/device-binding/contracts.ts";
const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  workspaceId: id,
  agentId: id,
  deviceAlias: "PC",
  ownerAlias: "Owner",
  repositoryAlias: "Repo",
  branch: "legacy",
  commit: "b".repeat(40),
  dirty: "unknown",
  sessionAlias: "Session",
  runtime: "codex",
  bindingEpoch: 1,
  state: "registered",
  verification: "unverified",
  lastSeenAt: "2026-10-14T02:04:00.000Z",
};
const queriedAt = "2026-10-14T02:03:00.000Z";
const gitReport = {
  branch: "dev",
  commit: "a".repeat(40),
  observedAt: "2026-10-14T02:02:00.000Z",
  receivedAt: "2026-10-14T02:02:01.000Z",
};
const response = (report: unknown = gitReport, time = queriedAt) => ({
  bindings: [{ ...binding, gitReport: report }],
  queriedAt: time,
});
const render = (report: unknown = gitReport, time = queriedAt) =>
  renderToStaticMarkup(
    createElement(RoomBindings, { bindings: projectRoomGitBindings(response(report, time)) }),
  );

test("should show actual branch short accessible full commit and distinct Git and PC times in real SSR", () => {
  const html = render();
  assert.match(html, /브랜치 dev/);
  assert.match(html, /커밋 aaaaaaa/);
  assert.match(html, new RegExp(`title="${"a".repeat(40)}"`));
  assert.match(html, /Git 확인:/);
  assert.match(html, /최근 수신 \(PC 통신\):/);
  assert.match(html, /작업 상태 미확인/);
  assert.doesNotMatch(html, /커밋 bbbbbbb/);
  assert.match(html, new RegExp(new Date(gitReport.observedAt).toLocaleString("ko-KR")));
  assert.match(html, new RegExp(new Date(binding.lastSeenAt).toLocaleString("ko-KR")));
});
test("should mark stale at the exact two minute query boundary and refresh to newly received report", () => {
  assert.doesNotMatch(render(gitReport, "2026-10-14T02:03:59.999Z"), /이전 Git 확인값/);
  assert.match(render(gitReport, "2026-10-14T02:04:00.000Z"), /이전 Git 확인값/);
  const next = {
    ...gitReport,
    branch: "main",
    commit: "c".repeat(64),
    observedAt: "2026-10-14T02:04:00.000Z",
  };
  const html = render(next, "2026-10-14T02:04:00.001Z");
  assert.match(html, /브랜치 main/);
  assert.match(html, /커밋 ccccccc/);
  assert.doesNotMatch(html, /이전 Git 확인값/);
});
test("should distinguish no report unknown branch and legacy registration without claiming detached", () => {
  assert.match(render(null), /Git 확인 대기/);
  assert.match(render(null), /등록 당시 정보/);
  const unknown = render({ ...gitReport, branch: "unknown", commit: "unknown" });
  assert.match(unknown, /Git 정보 확인 불가/);
  assert.doesNotMatch(unknown, /등록 당시 정보/);
  const commitOnly = render({ ...gitReport, branch: "unknown" });
  assert.match(commitOnly, /브랜치 이름 미확인/);
  assert.doesNotMatch(commitOnly, /detached|분리/);
  assert.match(render({ ...gitReport, commit: "unknown" }), /브랜치 dev.*커밋 미확인/);
});
test("should strictly validate web only response without changing old exact bindings projection", () => {
  const projected = projectRoomGitBindings(response());
  assert.equal(projected[0].gitReport!.stale, false);
  for (const bad of [
    { ...response(), extra: true },
    { ...response(), queriedAt: "bad" },
    { ...response(), bindings: [{ ...binding }] },
    response({ ...gitReport, root: "/private" }),
    response({ ...gitReport, commit: "A".repeat(40) }),
    response({ ...gitReport, branch: null }),
    response({ ...gitReport, observedAt: "bad" }),
    response({ ...gitReport, receivedAt: null }),
    { ...response(), bindings: [{ ...binding, gitReport, extra: true }] },
  ])
    assert.throws(() => projectRoomGitBindings(bad));
  assert.deepEqual(projectResponse("bindings", { protocol: 1, bindings: [binding] }, true), {
    protocol: 1,
    bindings: [binding],
  });
  assert.throws(() =>
    projectResponse("bindings", { protocol: 1, bindings: [{ ...binding, gitReport }] }, true),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";
import {
  sourceDevice,
  sourceRead,
  sourceFixtureManifest,
  sourceFixtureAutoManifest,
  fixtureSourcePackets,
  sourceAttemptIdentity,
  uploadFixtureSource,
} from "../helpers/shared-source-history-fixture.js";
import {
  sourceStableJson,
  type SourceFileRow,
} from "../../src/features/investigation-coordinator/source-contracts.ts";
const options = { timeout: 300000 };
// Run on an owned fresh or upgraded 001–013 stack. SQL013 installation has a separate entry.
test(
  "should preserve target reservation aliases and expose only already confirmed exact terminal sources",
  options,
  async () => {
    await workflowCase("source-reservation-confirmation", async (f) => {
      await assertOwnedStack(f.stack.config);
      const s = await f.scene("source-reservation-confirmation"),
        admission = await f.start(s),
        a = await f.run(s.origin, admission.requestId!);
      const saved = (
        await f.stack.db.query(
          "select target from source_history_private.targets where request_id=$1 and room_id=$2",
          [a.requestId, s.scope.roomId],
        )
      ).rows[0].target;
      await f.stack.db.query(
        "update device_binding_private.agents set session_alias='Later session' where id=$1 and device_id=$2",
        [s.origin.agentId, s.origin.deviceId],
      );
      const source = sourceFixtureManifest(
          Array.from(
            { length: 32 },
            (_, index) => `${String(index).padStart(2, "0")}/${"\ud800".repeat(503)}.ts`,
          ),
        ),
        packets = fixtureSourcePackets(source.bytes, source.manifestHash),
        identity = sourceAttemptIdentity(a),
        ids = packets.map(() => randomUUID());
      assert.ok(packets.length > 1);
      const first = await sourceDevice(f, s.origin, "source-upload", {
        ...identity,
        operationId: ids[0],
        packetJson: JSON.stringify(packets[0]),
      });
      assert.equal(first.status, 200);
      const pending = await sourceDevice(f, s.origin, "source-confirm", {
        ...identity,
        manifestHash: source.manifestHash,
      });
      assert.equal((pending.data.data as { state: string }).state, "PARTIAL");
      const before = await f.history(s);
      for (const event of before.events.filter((e) => e.requestId === a.requestId))
        assert.notEqual((await sourceRead(f, s, event.eventId)).state, "CONFIRMED");
      await Promise.all(
        packets
          .slice(1)
          .reverse()
          .map((packet) =>
            sourceDevice(f, s.origin, "source-upload", {
              ...identity,
              operationId: ids[packet.index],
              packetJson: JSON.stringify(packet),
            }).then((r) => assert.equal(r.status, 200)),
          ),
      );
      assert.equal(
        (
          await sourceDevice(f, s.origin, "source-confirm", {
            ...identity,
            manifestHash: source.manifestHash,
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (
          await sourceDevice(f, s.origin, "source-upload", {
            ...identity,
            operationId: ids[0],
            packetJson: JSON.stringify(packets[0]),
          })
        ).data.data,
        first.data.data,
      );
      await f.complete(s.origin, a);
      const terminal = (await f.history(s)).events.find(
        (e) => e.requestId === a.requestId && e.kind === "SPEECH",
      )!;
      let page = await sourceRead(f, s, terminal.eventId),
        count = 0;
      assert.equal(page.state, "CONFIRMED");
      assert.deepEqual(page.target, saved);
      assert.equal(page.manifestHash, source.manifestHash);
      do {
        assert.ok(page.files.length <= 4);
        assert.ok(page.files.every((file) => file.phase === "INPUT" && file.callIndex === null));
        count += page.files.length;
        if (page.nextIndex === null) break;
        page = await sourceRead(f, s, terminal.eventId, page.nextIndex);
        assert.equal(page.manifestHash, source.manifestHash);
      } while (true);
      assert.equal(count, 32);
      // Byte-identical historical ACK replay remains separate from whole confirmation, even after terminal.
      assert.deepEqual(
        (
          await sourceDevice(f, s.origin, "source-upload", {
            ...identity,
            operationId: ids[0],
            packetJson: JSON.stringify(packets[0]),
          })
        ).data.data,
        first.data.data,
      );
    });
  },
);
test(
  "should bind AI QUESTION to its reserved PEER and never attach a later recipient manifest",
  options,
  async () => {
    await workflowCase("source-question-peer-target", async (f) => {
      const s = await f.scene("source-question-peer-target"),
        admission = await f.start(s),
        origin = await f.run(s.origin, admission.requestId!),
        question = await f.question(s.origin, origin);
      const event = (await f.history(s)).events.find(
        (e) => e.kind === "QUESTION" && e.questionId === question.questionId,
      )!;
      assert.equal(event.requestId, origin.requestId);
      const before = await sourceRead(f, s, event.eventId);
      assert.equal(before.state, "NO_SOURCE");
      assert.equal(before.target!.requestId, question.peerRequestId);
      assert.equal(before.target!.agentId, s.responder.agentId);
      const peer = await f.run(s.responder, question.peerRequestId!),
        source = sourceFixtureManifest(["src/peer.ts"]);
      for (const packet of fixtureSourcePackets(source.bytes, source.manifestHash))
        assert.equal(
          (
            await sourceDevice(f, s.responder, "source-upload", {
              ...sourceAttemptIdentity(peer),
              operationId: randomUUID(),
              packetJson: JSON.stringify(packet),
            })
          ).status,
          200,
        );
      await f.complete(s.responder, peer);
      assert.deepEqual(await sourceRead(f, s, event.eventId), before);
    });
  },
);
test(
  "should reject other room reads private direct grants and conflicting packet operations",
  options,
  async () => {
    await workflowCase("source-permission-conflict", async (f) => {
      const s = await f.scene("source-permission-conflict"),
        admission = await f.start(s),
        a = await f.run(s.origin, admission.requestId!),
        uploaded = await uploadFixtureSource(f, s, a);
      const bad = { ...uploaded.packets[0], chunkHash: "a".repeat(64) },
        conflict = await sourceDevice(f, s.origin, "source-upload", {
          ...sourceAttemptIdentity(a),
          operationId: uploaded.operations[0],
          packetJson: JSON.stringify(bad),
        });
      assert.equal(conflict.status, 400);
      const epoch = await sourceDevice(f, s.origin, "source-confirm", {
        ...sourceAttemptIdentity(a),
        bindingEpoch: a.bindingEpoch + 1,
        manifestHash: uploaded.source.manifestHash,
      });
      assert.equal(epoch.status, 403);
      const fence = await sourceDevice(f, s.origin, "source-confirm", {
        ...sourceAttemptIdentity(a),
        fence: a.fence + 1,
        manifestHash: uploaded.source.manifestHash,
      });
      assert.equal(fence.status, 409);
      const grants = (
        await f.stack.db.query(
          "select c.relname,has_table_privilege('service_role',c.oid,'select') service,has_table_privilege('authenticated',c.oid,'select') human,has_table_privilege('anon',c.oid,'select') device from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='source_history_private' and c.relkind='r'",
        )
      ).rows;
      assert.equal(grants.length, 5);
      assert.ok(grants.every((r) => !r.service && !r.human && !r.device));
      for (const role of ["anon", "authenticated", "service_role"] as const) {
        await f.stack.db.query("begin");
        try {
          await f.stack.db.query(`set local role ${role}`);
          await assert.rejects(
            f.stack.db.query(
              "select packet_json from source_history_private.packets where room_id=$1",
              [s.scope.roomId],
            ),
            { code: "42501" },
          );
        } finally {
          await f.stack.db.query("rollback");
        }
      }
      await f.complete(s.origin, a);
      const event = (await f.history(s)).events.find(
        (e) => e.kind === "SPEECH" && e.requestId === a.requestId,
      )!;
      const observerPage = await sourceRead(f, s, event.eventId, null, s.observer);
      assert.equal(observerPage.state, "CONFIRMED");
      const observerUpload = await s.observer.web.post("/api/workflow/source-upload", {
        protocol: 1,
        agentId: s.origin.agentId!,
        bindingEpoch: a.bindingEpoch,
        ...sourceAttemptIdentity(a),
        operationId: randomUUID(),
        packetJson: JSON.stringify(uploaded.packets[0]),
      });
      assert.equal(observerUpload.status, 401);
      const outsiderRead = await s.outsider.web.post("/api/investigations/source-read", {
        protocol: 1,
        roomId: s.scope.roomId,
        eventId: event.eventId,
        afterIndex: null,
      });
      assert.equal(outsiderRead.status, 403);
      const other = await f.scene("source-permission-other-room"),
        response = await other.owner.web.post("/api/investigations/source-read", {
          protocol: 1,
          roomId: other.scope.roomId,
          eventId: event.eventId,
          afterIndex: null,
        });
      assert.equal(response.status, 404);
    });
  },
);
test(
  "should match JS canonical token codeunits and v1 whole digest vectors in SQL",
  options,
  async () => {
    await workflowCase("source-token-vectors", async (f) => {
      await assertOwnedStack(f.stack.config);
      for (const value of [
        "\ud800",
        "\udc00",
        "\ud800\ud800",
        "\udc00\ud800",
        "😀",
        "\ue000",
        "\0",
        '\t"\\',
        "a".repeat(511),
        "a".repeat(512),
      ]) {
        const token = JSON.stringify(value),
          row = (
            await f.stack.db.query("select source_history_private.token_units($1) units", [token])
          ).rows[0];
        assert.deepEqual(
          row.units,
          Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)),
        );
      }
      for (const token of ['"\\u0061"', '"\\uD800"', '"\\ud83d\\ude00"', '"a\\/b"'])
        await assert.rejects(
          f.stack.db.query("select source_history_private.token_units($1)", [token]),
          { message: "INVALID_BODY" },
        );
      for (const paths of [
        [],
        ["\ud800.ts"],
        ["😀.ts", "\ue000.ts"],
        Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, "0")}.ts`),
      ]) {
        const source = sourceFixtureManifest(paths);
        await f.stack.db.query("select source_history_private.input($1::jsonb)", [
          JSON.stringify(source.manifest.input),
        ]);
        const row = (
          await f.stack.db.query(
            "select source_history_private.canonical($1::jsonb) canonical,source_history_private.digest(source_history_private.canonical($1::jsonb)) hash",
            [JSON.stringify(source.manifest)],
          )
        ).rows[0];
        assert.equal(row.canonical, sourceStableJson(source.manifest));
        assert.equal(row.hash, source.manifestHash);
      }
      const digest = createHash("sha256").update("a").digest("hex");
      assert.equal(digest.length, 64);
    });
  },
);

test(
  "should confirm mixed AUTO reports and preserve gaps repeated excerpts phases and original input through fixed RPC pages",
  options,
  async () => {
    await workflowCase("source-auto-mixed", async (f) => {
      const s = await f.scene("source-auto-mixed"),
        admission = await f.start(s),
        a = await f.run(s.origin, admission.requestId!),
        questionOperationId = randomUUID(),
        source = sourceFixtureAutoManifest(questionOperationId);
      const operationsBefore = f.operations.length;
      await uploadFixtureSource(f, s, a, source);
      assert.equal(f.operations.length, operationsBefore);
      const receipts = (
        await f.stack.db.query(
          "select count(*)::int count from workflow_private.receipts where room_id=$1 and actor_kind='device' and actor_id=$2 and operation_id=$3",
          [s.scope.roomId, s.origin.deviceId, questionOperationId],
        )
      ).rows[0].count;
      // A scoped, reported pre-question observation is valid without question delivery or a receipt.
      assert.equal(receipts, 0);
      await f.complete(s.origin, a, "COMPLETED", "AUTO 공개 결과");
      const terminal = (await f.history(s)).events.find(
        (e) => e.kind === "SPEECH" && e.requestId === a.requestId,
      )!;
      let page = await sourceRead(f, s, terminal.eventId);
      const { entries, ...inputFiles } = source.manifest.input.files;
      assert.deepEqual(page.summary, {
        readMode: "AUTO_CODE",
        input: { ...source.manifest.input, files: { ...inputFiles, entryCount: entries.length } },
        callCount: 4,
        repositoryCallCount: 3,
        peerCallCount: 1,
        listCallCount: 1,
        fileCount: 6,
      });
      assert.equal(
        page.summary!.input.files.manifestHash,
        source.manifest.input.files.manifestHash,
      );
      assert.equal(page.summary!.input.observationHash, source.manifest.input.observationHash);
      assert.equal(page.summary!.input.git.refJson, JSON.stringify("null"));
      const rows: SourceFileRow[] = [];
      do {
        assert.equal(page.manifestHash, source.manifestHash);
        assert.ok(page.files.length <= 4);
        assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 16384);
        rows.push(...page.files);
        if (page.nextIndex === null) break;
        const after = page.nextIndex;
        page = await sourceRead(f, s, terminal.eventId, after);
        assert.equal(page.files[0].index, after + 1);
      } while (true);
      assert.deepEqual(
        rows.map((row) => row.index),
        [0, 1, 2, 3, 4, 5],
      );
      assert.deepEqual(
        rows.map((row) => row.callIndex),
        [2, 5, 5, 5, 9, 9],
      );
      assert.deepEqual(
        rows.map((row) => row.excerptIndex),
        [0, 0, 1, 2, 0, 1],
      );
      assert.equal(rows.filter((row) => row.phase === "INPUT").length, 0);
      assert.equal(rows.filter((row) => row.phase === "REPOSITORY").length, 4);
      assert.equal(rows.filter((row) => row.phase === "PEER").length, 2);
      const expected = source.manifest.calls
        .flatMap((call) =>
          call.files.map((file) => ({
            index: 0,
            phase: call.kind === "PEER_EVIDENCE_OBSERVATION" ? "PEER" : "REPOSITORY",
            callIndex: call.callIndex,
            excerptIndex: file.excerptIndex,
            tool: call.kind === "REPOSITORY_TOOL_OBSERVATION" ? call.tool : null,
            resultHash: call.kind === "REPOSITORY_TOOL_OBSERVATION" ? call.resultHash : null,
            questionOperationId:
              call.kind === "PEER_EVIDENCE_OBSERVATION" ? call.questionOperationId : null,
            pathJson: file.pathJson,
            hash: file.hash,
            readAt: file.readAt,
            byteStart: file.byteStart,
            byteEnd: file.byteEnd,
            excerptHash: file.excerptHash,
            lineCount: "lineCount" in file ? file.lineCount : null,
            requestedStartLine: "requestedStartLine" in file ? file.requestedStartLine : null,
            requestedEndLine: "requestedEndLine" in file ? file.requestedEndLine : null,
          })),
        )
        .map((row, index) => ({ ...row, index }));
      assert.deepEqual(rows, expected);
      assert.equal(rows[0].pathJson, JSON.stringify("src/auth/route.ts"));
      assert.equal(rows[0].pathJson, rows[1].pathJson);
      assert.equal(rows[0].pathJson, rows[4].pathJson);
      assert.equal(
        new Set([rows[0].excerptHash, rows[1].excerptHash, rows[4].excerptHash]).size,
        3,
      );
      assert.equal(rows[4].byteStart, 32);
      assert.equal(rows[4].requestedStartLine, 2);
      assert.equal(rows[4].requestedEndLine, 3);
      assert.equal(rows[4].questionOperationId, questionOperationId);
    });
  },
);

test(
  "should reject correctly hashed noncanonical whole bytes and invalid AUTO fields with scoped transaction rollback",
  options,
  async () => {
    await workflowCase("source-whole-rejection", async (f) => {
      const selected = sourceFixtureManifest(
        Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, "0")}/${"a".repeat(500)}.ts`),
      );
      const auto = sourceFixtureAutoManifest(randomUUID());
      const canonical = selected.bytes.toString("utf8");
      const badAuto = (change: (manifest: typeof auto.manifest) => void) => {
        const manifest = structuredClone(auto.manifest);
        change(manifest);
        return Buffer.from(sourceStableJson(manifest));
      };
      const invalidUtf8 = Buffer.from(selected.bytes);
      invalidUtf8[0] = 0xff;
      const cases: [string, Buffer][] = [
        ["duplicate-key", Buffer.from(canonical.replace('"version":2', '"version":2,"version":2'))],
        ["whitespace", Buffer.from(` ${canonical}`)],
        ["numeric", Buffer.from(canonical.replace('"version":2', '"version":2e0'))],
        ["invalid-utf8", invalidUtf8],
        ["auto-private-field", badAuto((m) => Object.assign(m.calls[1], { root: "/private" }))],
        [
          "auto-list-files",
          badAuto((m) => {
            m.calls[0].files = structuredClone(m.calls[1].files);
          }),
        ],
        [
          "auto-excerpt-index",
          badAuto((m) => {
            m.calls[2].files[1].excerptIndex = 0;
          }),
        ],
        ["peer-purpose", badAuto((m) => Object.assign(m.calls[3], { purpose: "DELIVERED" }))],
        [
          "peer-operation",
          badAuto((m) => Object.assign(m.calls[3], { questionOperationId: "not-an-operation" })),
        ],
        [
          "peer-requested-lines",
          badAuto((m) => Object.assign(m.calls[3].files[0], { requestedEndLine: 13 })),
        ],
      ];
      for (const [label, bytes] of cases) {
        // Packet addresses are immutable, so every malformed whole uses a fresh owned attempt.
        const s = await f.scene(`source-reject-${label}`),
          admission = await f.start(s),
          a = await f.run(s.origin, admission.requestId!),
          manifestHash = createHash("sha256").update(bytes).digest("hex"),
          packets = fixtureSourcePackets(bytes, manifestHash),
          operationIds = packets.map(() => randomUUID());
        for (const packet of packets) {
          assert.equal(
            packet.chunkHash,
            createHash("sha256").update(Buffer.from(packet.bytesBase64, "base64")).digest("hex"),
          );
          const response = await sourceDevice(f, s.origin, "source-upload", {
            ...sourceAttemptIdentity(a),
            operationId: operationIds[packet.index],
            packetJson: JSON.stringify(packet),
          });
          if (packet.index === packets.length - 1) {
            assert.equal(response.status, 400, label);
            assert.equal(response.data.ok, false);
            assert.equal((response.data.error as { code: string }).code, "INVALID_BODY");
          } else assert.equal(response.status, 200, label);
        }
        const confirmation = await sourceDevice(f, s.origin, "source-confirm", {
          ...sourceAttemptIdentity(a),
          manifestHash,
        });
        assert.equal(confirmation.status, 200);
        assert.equal(
          (confirmation.data.data as { state: string }).state,
          packets.length === 1 ? "ABSENT" : "PARTIAL",
        );
        const row = (
          await f.stack.db.query(
            "select (select count(*)::int from source_history_private.manifests where attempt_id=$1 and room_id=$2 and confirmed) confirmed,(select count(*)::int from source_history_private.packets where attempt_id=$1 and room_id=$2) packets,(select count(*)::int from source_history_private.files x join source_history_private.manifests m on m.attempt_id=x.attempt_id where m.attempt_id=$1 and m.room_id=$2) files,(select count(*)::int from source_history_private.events x join public.workflow_events e on e.event_id=x.event_id where x.attempt_id=$1 and e.room_id=$2) events",
            [a.attemptId, s.scope.roomId],
          )
        ).rows[0];
        assert.deepEqual(row, { confirmed: 0, packets: packets.length - 1, files: 0, events: 0 });
        await f.complete(s.origin, a, "COMPLETED", `rejected-${label}`);
        const event = (await f.history(s)).events.find(
          (e) => e.kind === "SPEECH" && e.requestId === a.requestId,
        )!;
        const publicPage = await sourceRead(f, s, event.eventId);
        assert.equal(publicPage.state, "NO_SOURCE");
        assert.equal(publicPage.manifestHash, null);
        assert.deepEqual(publicPage.files, []);
      }
    });
  },
);

test(
  "should retain exact UNKNOWN observed terminal source after explicit human resume and a newer source attempt",
  options,
  async () => {
    await workflowCase("source-unknown-resume", async (f) => {
      const s = await f.scene("source-unknown-resume"),
        admission = await f.start(s),
        abandoned = await f.claim(s.origin, admission.requestId!);
      await f.expire("lease", abandoned.attemptId);
      await f.poll(s.origin);
      const a = await f.run(s.origin, admission.requestId!);
      assert.equal(a.fence, abandoned.fence + 1);
      const reserved = (
        await f.stack.db.query(
          "select target from source_history_private.targets where request_id=$1 and room_id=$2",
          [a.requestId, s.scope.roomId],
        )
      ).rows[0].target;
      await f.expire("lease", a.attemptId);
      const unknown = await f.poll(s.origin);
      assert.equal(unknown.attempt?.state, "UNKNOWN");
      const source = sourceFixtureManifest(["src/old-terminal.ts"]);
      await uploadFixtureSource(f, s, a, source);
      const observed = await f.device(s.origin, "observe", {
        ...f.identity(a),
        terminal: "COMPLETED",
        publicText: "UNKNOWN 이후 실제 종결",
      });
      assert.equal(observed.status, 200);
      const receipt = observed.data.data as {
        adoption: string;
        continuationRequestId: string | null;
      };
      assert.equal(receipt.adoption, "HISTORICAL");
      assert.equal(receipt.continuationRequestId, null);
      const history = await f.history(s),
        oldEvents = history.events.filter(
          (event) =>
            event.requestId === a.requestId &&
            (event.kind === "SPEECH" || event.terminal === "COMPLETED"),
        );
      assert.equal(oldEvents.length, 2);
      const savedPages = await Promise.all(
        oldEvents.map((event) => sourceRead(f, s, event.eventId)),
      );
      for (const page of savedPages) {
        assert.equal(page.state, "CONFIRMED");
        assert.equal(page.manifestHash, source.manifestHash);
        assert.deepEqual(page.target, reserved);
      }
      await f.stack.db.query(
        "update device_binding_private.agents set session_alias='Current replacement alias' where id=$1 and device_id=$2 and room_id=$3",
        [s.origin.agentId, s.origin.deviceId, s.scope.roomId],
      );
      const h = await f.read(s);
      // The existing human API resumes with a fresh request; it has no historical-result adoption RPC.
      const resumed = await f.human(s.owner, "resume", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        mode: "cycle",
        cycleId: h.cycle!.cycleId,
        originAgentId: s.origin.agentId!,
        peerAgentId: s.responder.agentId!,
        originEpoch: await f.epoch(s.origin),
        peerEpoch: await f.epoch(s.responder),
        expectedRoomRevision: h.roomRevision,
        publicText: "사람이 명시적으로 재개",
        confirmed: true,
      });
      assert.equal(resumed.status, 200);
      const nextRequest = resumed.data.data as { requestId: string; accepted: boolean };
      assert.equal(nextRequest.accepted, true);
      assert.notEqual(nextRequest.requestId, a.requestId);
      const next = await f.run(s.origin, nextRequest.requestId),
        newer = sourceFixtureManifest(["src/newer.ts"]);
      await uploadFixtureSource(f, s, next, newer);
      await f.complete(s.origin, next);
      const newEvent = (await f.history(s)).events.find(
        (event) => event.kind === "SPEECH" && event.requestId === next.requestId,
      )!;
      assert.equal((await sourceRead(f, s, newEvent.eventId)).manifestHash, newer.manifestHash);
      for (let i = 0; i < oldEvents.length; i++) {
        assert.deepEqual(await sourceRead(f, s, oldEvents[i].eventId), savedPages[i]);
        const link = (
          await f.stack.db.query(
            "select x.attempt_id,m.fence,m.manifest_hash,x.target from source_history_private.events x join source_history_private.manifests m on m.attempt_id=x.attempt_id where x.event_id=$1 and m.room_id=$2 and x.request_id=$3",
            [oldEvents[i].eventId, s.scope.roomId, a.requestId],
          )
        ).rows[0];
        assert.equal(link.attempt_id, a.attemptId);
        assert.equal(Number(link.fence), a.fence);
        assert.equal(link.manifest_hash, source.manifestHash);
        assert.deepEqual(link.target, reserved);
      }
    });
  },
);

test(
  "should attach both pending and newly accepted peer answer events to the same original exact source",
  options,
  async () => {
    await workflowCase("source-peer-adoption", async (f) => {
      const s = await f.scene("source-peer-adoption"),
        admission = await f.start(s),
        origin = await f.run(s.origin, admission.requestId!),
        question = await f.question(s.origin, origin),
        peer = await f.run(s.responder, question.peerRequestId!),
        source = sourceFixtureManifest(["src/adopted-peer.ts"]);
      const saved = (
        await f.stack.db.query(
          "select target from source_history_private.targets where request_id=$1 and room_id=$2",
          [peer.requestId, s.scope.roomId],
        )
      ).rows[0].target;
      for (const packet of fixtureSourcePackets(source.bytes, source.manifestHash))
        assert.equal(
          (
            await sourceDevice(f, s.responder, "source-upload", {
              ...sourceAttemptIdentity(peer),
              operationId: randomUUID(),
              packetJson: JSON.stringify(packet),
            })
          ).status,
          200,
        );
      const peerReceipt = await f.complete(s.responder, peer);
      assert.equal(peerReceipt.adoption, "PENDING");
      assert.equal(peerReceipt.continuationRequestId, null);
      const pending = (await f.history(s)).events.find(
        (e) => e.kind === "ANSWER" && e.requestId === peer.requestId && e.adoption === "PENDING",
      )!;
      const pendingPage = await sourceRead(f, s, pending.eventId);
      assert.equal(pendingPage.manifestHash, source.manifestHash);
      assert.deepEqual(pendingPage.target, saved);
      await f.stack.db.query(
        "update device_binding_private.agents set session_alias='Current peer alias' where id=$1 and device_id=$2 and room_id=$3",
        [s.responder.agentId, s.responder.deviceId, s.scope.roomId],
      );
      const originReceipt = await f.complete(s.origin, origin);
      assert.ok(originReceipt.continuationRequestId);
      const accepted = (await f.history(s)).events.find(
        (e) => e.kind === "ANSWER" && e.requestId === peer.requestId && e.adoption === "ACCEPTED",
      )!;
      assert.notEqual(accepted.eventId, pending.eventId);
      const acceptedPage = await sourceRead(f, s, accepted.eventId);
      assert.equal(acceptedPage.manifestHash, source.manifestHash);
      assert.deepEqual(acceptedPage.target, saved);
      assert.deepEqual(await sourceRead(f, s, pending.eventId), pendingPage);
      for (const event of [pending, accepted]) {
        const link = (
          await f.stack.db.query(
            "select x.attempt_id,m.fence,m.manifest_hash,x.target from source_history_private.events x join source_history_private.manifests m on m.attempt_id=x.attempt_id where x.event_id=$1 and m.room_id=$2 and x.request_id=$3",
            [event.eventId, s.scope.roomId, peer.requestId],
          )
        ).rows[0];
        assert.equal(link.attempt_id, peer.attemptId);
        assert.equal(Number(link.fence), peer.fence);
        assert.equal(link.manifest_hash, source.manifestHash);
        assert.deepEqual(link.target, saved);
      }
      const continuation = await f.run(s.origin, originReceipt.continuationRequestId!);
      const newer = sourceFixtureManifest(["src/newer-adoption.ts"]);
      await uploadFixtureSource(f, s, continuation, newer);
      await f.complete(s.origin, continuation);
      assert.deepEqual(await sourceRead(f, s, pending.eventId), pendingPage);
      assert.deepEqual(await sourceRead(f, s, accepted.eventId), acceptedPage);
    });
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import { NativeTransport } from "../src/native-transport.js";
import { ProbeError } from "../src/owned-probe-store.js";
import { Fixture } from "./helpers.js";

test("should accept only the exact replay of an answered native control request", async (t) => {
  for (const mode of ["replay-control", "replay-control-reordered", "replay-control-mutated",
    "replay-control-unknown-id", "replay-control-duplicate", "replay-control-disabled"]) {
    await t.test(mode, async () => {
      const f = new Fixture();
      let transport: NativeTransport | undefined;
      let callbacks = 0;
      try {
        const policy = f.policy();
        policy.admit();
        const args = policy.arguments(f.store.read().sessionId, false);
        if (mode !== "replay-control-disabled") args.push("--replay-user-messages");
        transport = new NativeTransport(f.launch(mode, args), () => {},
          { requestMs: 300, probeMs: 1500, closeMs: [20, 50, 50] });
        transport.setHandler(async (frame) => {
          assert.equal(frame.type, "control_request");
          callbacks++;
          await transport!.reply(String(frame.request_id), {
            mcp_response: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } },
          });
        }, () => {});
        const result = transport.request({ subtype: "initialize", sdkMcpServers: ["owned_probe"] });
        if (["replay-control", "replay-control-reordered"].includes(mode)) {
          assert.deepEqual(await result, { commands: [], models: [] });
          await transport.settleMessages();
          assert.equal(transport.replayedResponseCount, 1);
        } else {
          await assert.rejects(result, (error: unknown) => error instanceof ProbeError && error.code === "PROTOCOL_REJECTED");
        }
        assert.equal(callbacks, 1);
        assert.equal(f.events().filter(event => event.event === "input").length, 0);
        assert.equal(f.budget.read().slots.length, 0);
      } finally {
        if (transport) {
          assert.equal((await transport.close()).reaped, true);
          assert.equal(transport.pendingCount, 0);
        }
        f.dispose();
      }
    });
  }
});

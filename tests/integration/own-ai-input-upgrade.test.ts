import test from "node:test";
import {
  WorkflowFixture,
  assertOwnInputUpgradePreconditions,
  runOwnInputUpgradeDriver,
} from "../helpers/workflow-fixture.js";

// Explicit runner: node --test .integration-build/tests/integration/own-ai-input-upgrade.test.js
// Requires the existing owned 001–010 stack. An already installed SQL011 fails without reapplying it.
test(
  "should install only additive SQL011 on the same warmed owned backend and preserve original receipts",
  { timeout: 300000 },
  async () => {
    const fixture = await WorkflowFixture.open("own-input-warm-upgrade");
    try {
      await assertOwnInputUpgradePreconditions(fixture);
      await runOwnInputUpgradeDriver(fixture);
    } finally {
      await fixture.close();
    }
  },
);

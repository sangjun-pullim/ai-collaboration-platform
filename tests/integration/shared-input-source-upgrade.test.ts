import test from "node:test";
import { WorkflowFixture } from "../helpers/workflow-fixture.js";
import { upgradeSharedSourceHistory } from "../helpers/shared-source-history-fixture.js";

const options = { timeout: 300000 };

// Explicit runner: node --test .integration-build/tests/integration/shared-input-source-upgrade.test.js
// Requires the existing owned 001–012 stack. An already installed SQL013 fails without reapplying it.
test(
  "should preserve warmed 001–012 history and receipt bytes through additive SQL013",
  options,
  async () => {
    const f = await WorkflowFixture.open("shared-source-warm-upgrade");
    try {
      await upgradeSharedSourceHistory(f);
    } finally {
      await f.close();
    }
  },
);

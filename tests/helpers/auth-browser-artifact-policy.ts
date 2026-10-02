import type { test as playwrightTest, TestInfoError } from "@playwright/test";
import type { Reporter, TestCase, TestError, TestResult, TestStep } from "@playwright/test/reporter";

const safeFailure = "Auth browser check failed. Sensitive diagnostics were withheld.";
export const authBrowserChildEnvironment = { PLAYWRIGHT_NO_COPY_PROMPT: "1" } as const;

function sanitizeError(error: TestInfoError) {
  // Drop the whole serialized error payload, including context, cause, value and snippets.
  const payload = error as unknown as Record<string, unknown>;
  for (const field of Object.keys(payload)) delete payload[field];
  error.message = safeFailure;
}
export function installAuthArtifactPolicy(test: typeof playwrightTest) {
  test.afterEach(({ browserName }, info) => {
    void browserName;
    // Runs before artifact fixture teardown can write error-context.md.
    for (const error of info.errors) sanitizeError(error);
  });
}
function sanitizeStep(step: TestStep) {
  // Even successful fill steps can put OTP input values into reporter step titles.
  const category = ["expect", "pw:api", "test.step", "hook", "fixture"].includes(step.category) ? step.category : "check";
  step.title = `Auth browser ${category} step`;
  if (step.error) sanitizeError(step.error);
  for (const child of step.steps) sanitizeStep(child);
}
export default class AuthBrowserArtifactReporter implements Reporter {
  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep) { sanitizeStep(step); }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) { sanitizeStep(step); }
  onTestEnd(_test: TestCase, result: TestResult) {
    if (result.error) sanitizeError(result.error);
    for (const error of result.errors) sanitizeError(error);
    for (const step of result.steps) sanitizeStep(step);
  }
  onError(error: TestError) { sanitizeError(error); }
}

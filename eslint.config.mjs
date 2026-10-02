import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores(["node_modules/**", "packages/local-connector/node_modules/**", "packages/local-connector/dist/**", ".next/**", ".test-build/**", ".integration-build/**", ".workflow-artifacts/**", "experiments/**", "test-results/**", "playwright-report/**", "next-env.d.ts"]),
]);

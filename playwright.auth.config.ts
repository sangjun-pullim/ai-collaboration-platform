import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "web-auth-room-access.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["./tests/helpers/auth-browser-artifact-policy.ts"], ["list"]],
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:4318", trace: "off", screenshot: "off", video: "off" },
  projects: [
    {
      name: "auth-desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "auth-mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "node scripts/access-web-server.mjs",
    url: "http://127.0.0.1:4318/login",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

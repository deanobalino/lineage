import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3317",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1536, height: 1024 } }
    },
    {
      name: "tablet",
      use: { ...devices["iPad Pro 11 landscape"], browserName: "chromium" }
    },
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true
      }
    }
  ]
});

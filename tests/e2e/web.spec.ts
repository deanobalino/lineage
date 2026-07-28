import { expect, test, type Page } from "@playwright/test";

async function loginAndOpenDemo(page: Page) {
  const token = process.env["LINEAGE_E2E_OPERATOR_TOKEN"];
  if (!token) throw new Error("E2E operator token is missing.");
  await page.goto("/");
  await page.getByLabel("Operator token").fill(token);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/repositories$/);
  await page.getByRole("button", { name: "Open demo repository" }).click();
  await expect(page).toHaveURL(/\/review/);
  await expect(page.getByRole("heading", { name: "src/retry.ts" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await loginAndOpenDemo(page);
});

test("reviews a real branch and opens its recorded evidence", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await expect(page.getByText(/1 file/).first()).toBeVisible();
  const addedLine = page.locator(".diff-line--addition").filter({ hasText: "Math.min" });
  await addedLine.click();
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: /Open evidence/ }).click();
  }
  await expect(page.getByText("Recorded provenance").last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex" }).last()).toBeVisible();
  await expect(page.getByText(/Keep retries bounded/).last()).toBeVisible();
  await expect(page.getByRole("link", { name: "View full session" }).last()).toBeVisible();
  if (process.env["LINEAGE_QA_SCREENSHOTS"]) {
    await page.screenshot({
      path: `/tmp/lineage-review-${testInfo.project.name}.png`,
      fullPage: true
    });
  }
  expect(consoleErrors).toEqual([]);
});

test("preserves Explore, sessions, capture, and exports at every viewport", async ({ page }) => {
  const repositoryUrl = new URL(page.url());
  const repositoryId = repositoryUrl.pathname.split("/")[2];
  if (!repositoryId) throw new Error("Repository id missing from Review URL.");

  if (page.viewportSize()!.width < 768) {
    await page.getByRole("button", { name: "Explore" }).click();
  } else {
    await page.getByRole("link", { name: "Explore" }).click();
  }
  await expect(page).toHaveURL(/\/explore/);
  await expect(page.getByRole("heading", { name: "src/retry.ts" })).toBeVisible();
  await page.locator(".source-line").filter({ hasText: "MAX_RETRIES" }).click();
  if (page.viewportSize()!.width < 768) {
    await page.getByRole("button", { name: /Open evidence/ }).click();
    await expect(page.getByRole("button", { name: /Back to diff/ })).toBeVisible();
    await page.keyboard.press("Escape");
  }

  await page.goto(`/r/${repositoryId}/sessions`);
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByText("Keep retries bounded while smoothing the backoff.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Export Agent Trace" })).toHaveAttribute("href", /agent-trace/);

  await page.goto(`/r/${repositoryId}/capture`);
  await expect(page.getByRole("heading", { name: "Capture", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Install/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay queue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover Codex transcripts" })).toBeVisible();
});

test("renders hostile repository, diff, and commit text as inert content", async ({ page }) => {
  const path = process.env["LINEAGE_E2E_HOSTILE_REPOSITORY"];
  if (!path) throw new Error("Hostile fixture path is missing.");
  await page.goto("/repositories");
  await page.getByLabel("Path on this server").fill(path);
  await page.getByRole("button", { name: "Open repository" }).click();
  await expect(page.getByRole("heading", { name: "src/payload.ts" })).toBeVisible();
  await expect(page.getByText(/svg onload/).last()).toBeVisible();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(1);
  expect(await page.evaluate(() => (window as Window & { __lineageXss?: number }).__lineageXss))
    .toBeUndefined();
});

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
  if (testInfo.project.name === "phone") {
    await expect.poll(async () => (await addedLine.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await addedLine.click();
  if (testInfo.project.name === "phone") {
    const openEvidence = page.getByRole("button", { name: /Open evidence/ });
    await expect.poll(async () => (await openEvidence.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    await openEvidence.click();
  }
  await expect(page.getByText("Recorded provenance").last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex" }).last()).toBeVisible();
  await expect(page.getByText(/Keep retries bounded/).last()).toBeVisible();
  await expect(page.getByRole("link", { name: "View full session" }).last()).toBeVisible();
  if (testInfo.project.name === "phone") {
    const firstDisclosure = page.locator(".evidence-sheet .evidence-inspector summary").first();
    await expect.poll(async () => (await firstDisclosure.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    const exportControl = page.getByRole("link", { name: "Export explanation" }).last();
    await expect.poll(async () => {
      const box = await exportControl.boundingBox();
      return Math.min(box?.width ?? 0, box?.height ?? 0);
    }).toBeGreaterThanOrEqual(44);
  }
  if (process.env["LINEAGE_QA_SCREENSHOTS"]) {
    await page.screenshot({
      path: `/tmp/lineage-review-${testInfo.project.name}.png`,
      fullPage: true
    });
  }
  expect(consoleErrors).toEqual([]);
});

test("operates repository controls and evidence workflows at every viewport", async ({ page }) => {
  const repositoryUrl = new URL(page.url());
  const repositoryId = repositoryUrl.pathname.split("/")[2];
  if (!repositoryId) throw new Error("Repository id missing from Review URL.");

  const phone = page.viewportSize()!.width < 768;
  if (phone) {
    await page.getByRole("button", { name: "Repository actions" }).click();
    await page.getByRole("menuitem", { name: "Branch and base" }).click();
    const controls = page.getByRole("dialog", { name: "Repository controls" });
    const branch = controls.getByLabel("Current branch");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/repositories/${repositoryId}/branch`) &&
          response.status() === 200
      ),
      branch.selectOption("main")
    ]);
    await expect(branch).toHaveValue("main");
    await controls.getByLabel("Comparison base").selectOption("review/retry-policy");
    await expect(page).toHaveURL(/base=review%2Fretry-policy/);
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/repositories/${repositoryId}/branch`) &&
          response.status() === 200
      ),
      branch.selectOption("review/retry-policy")
    ]);
    await expect(branch).toHaveValue("review/retry-policy");
    await controls.getByLabel("Comparison base").selectOption("main");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/repositories/${repositoryId}/refresh`) &&
          response.status() === 200
      ),
      controls.getByRole("button", { name: "Refresh repository" }).click()
    ]);
  } else {
    const branch = page.getByLabel("Current branch");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/repositories/${repositoryId}/branch`) &&
          response.status() === 200
      ),
      branch.selectOption("main")
    ]);
    await expect(branch).toHaveValue("main");
    await page.getByLabel("Base").selectOption("review/retry-policy");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/repositories/${repositoryId}/branch`) &&
          response.status() === 200
      ),
      branch.selectOption("review/retry-policy")
    ]);
    await expect(branch).toHaveValue("review/retry-policy");
    await page.getByLabel("Base").selectOption("main");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/repositories/${repositoryId}/refresh`) &&
          response.status() === 200
      ),
      page.getByRole("button", { name: "Refresh repository" }).click()
    ]);
  }

  if (phone) {
    await page.getByRole("button", { name: "Explore" }).click();
  } else {
    await page.getByRole("link", { name: "Explore" }).click();
  }
  await expect(page).toHaveURL(/\/explore/);
  await expect(page.getByRole("heading", { name: "src/retry.ts" })).toBeVisible();
  await page.locator(".source-line").filter({ hasText: "MAX_RETRIES" }).click();
  if (phone) {
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
  await expect(page.locator(".harnesses code").first()).toContainText(".codex/config.toml");
  await expect(page.getByText("Not configured").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Install/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay queue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover Codex transcripts" })).toBeVisible();
});

test("recovers an expired session and preserves the intended route", async ({ page }) => {
  const intended = new URL(page.url());
  const intendedRoute = `${intended.pathname}${intended.search}`;
  await page.context().clearCookies();
  await page.getByRole("link", { name: "Export" }).click();
  await expect(page).toHaveURL(/\/login$/);

  const token = process.env["LINEAGE_E2E_OPERATOR_TOKEN"];
  if (!token) throw new Error("E2E operator token is missing.");
  await page.getByLabel("Operator token").fill(token);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === intendedRoute);
  await expect(page.getByRole("heading", { name: "src/retry.ts" })).toBeVisible();
});

test("explains and exports a deleted old-side line", async ({ page }) => {
  const path = process.env["LINEAGE_E2E_HOSTILE_REPOSITORY"];
  if (!path) throw new Error("Hostile fixture path is missing.");
  await page.goto("/repositories");
  await page.getByLabel("Path on this server").fill(path);
  await page.getByRole("button", { name: "Open repository" }).click();
  await expect(page.getByRole("heading", { name: "src/payload.ts" })).toBeVisible();

  if (page.viewportSize()!.width < 1280) {
    await page.getByRole("button", { name: /files/ }).click();
  }
  await page.getByRole("button", { name: /src\/removed\.ts/ }).click();
  await expect(page.getByRole("heading", { name: "src/removed.ts" })).toBeVisible();
  const explanationResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/explain") &&
      url.searchParams.get("side") === "old" &&
      url.searchParams.get("base") === "main" &&
      url.searchParams.get("previousPath") === "src/removed.ts"
    );
  });
  await page
    .locator(".diff-line--deletion")
    .filter({ hasText: "available only at the merge base" })
    .click();
  expect((await explanationResponse).status()).toBe(200);
  await expect(page).toHaveURL(/side=old/);
  if (page.viewportSize()!.width < 768) {
    await page.getByRole("button", { name: /Open evidence/ }).click();
  }
  await expect(page.getByText("Git inference only").last()).toBeVisible();
  await expect(page.getByRole("link", { name: "Export explanation" }).last())
    .toHaveAttribute("href", /side=old/);
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

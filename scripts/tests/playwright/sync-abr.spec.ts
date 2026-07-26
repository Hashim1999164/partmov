/**
 * Playwright two-browser outline — run with stack up:
 *   npx playwright test scripts/tests/playwright/sync-abr.spec.ts
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE || "http://127.0.0.1:3000";

test.describe("Streaming V2 gates (skipped unless STREAMING_V2_E2E=1)", () => {
  test.skip(!process.env.STREAMING_V2_E2E, "Requires live stack + flag");

  test("two browsers open cinema lobby", async ({ browser }) => {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await a.goto(`${BASE}/watch`);
    await b.goto(`${BASE}/watch`);
    await expect(a.locator("body")).toBeVisible();
    await expect(b.locator("body")).toBeVisible();
  });
});

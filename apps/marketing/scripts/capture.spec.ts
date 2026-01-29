import { test } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE_URL = "http://localhost:3004";
const OUTPUT_DIR = path.join(__dirname, "..", "output");

const screenshots = [
  {
    name: "hero",
    path: "/screenshots/hero",
    width: 1320,
    height: 2868,
    deviceScaleFactor: 1,
  },
  {
    name: "feature-1",
    path: "/screenshots/feature-1",
    width: 1320,
    height: 2868,
    deviceScaleFactor: 1,
  },
  {
    name: "feature-2",
    path: "/screenshots/feature-2",
    width: 1320,
    height: 2868,
    deviceScaleFactor: 1,
  },
  {
    name: "dark-mode",
    path: "/screenshots/dark-mode",
    width: 1320,
    height: 2868,
    deviceScaleFactor: 1,
  },
  {
    name: "collaboration",
    path: "/screenshots/collaboration",
    width: 1320,
    height: 2868,
    deviceScaleFactor: 1,
  },
];

test.beforeAll(async () => {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
});

test.describe("App Store Screenshots", () => {
  for (const screenshot of screenshots) {
    test(`capture ${screenshot.name}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: {
          width: screenshot.width,
          height: screenshot.height,
        },
        deviceScaleFactor: screenshot.deviceScaleFactor,
      });

      const page = await context.newPage();

      // Navigate to the screenshot page
      await page.goto(`${BASE_URL}${screenshot.path}`, {
        waitUntil: "networkidle",
      });

      // Wait for any animations to complete
      await page.waitForTimeout(500);

      // Find the screenshot container
      const screenshotElement = page.locator('[data-screenshot="true"]').first();

      // Capture the screenshot
      const outputPath = path.join(OUTPUT_DIR, `${screenshot.name}.png`);
      await screenshotElement.screenshot({
        path: outputPath,
        type: "png",
      });

      console.log(`Captured: ${outputPath}`);

      await context.close();
    });
  }
});

test.describe("High-DPI Screenshots (2x)", () => {
  for (const screenshot of screenshots) {
    test(`capture ${screenshot.name} @2x`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: {
          width: screenshot.width,
          height: screenshot.height,
        },
        deviceScaleFactor: 2,
      });

      const page = await context.newPage();

      await page.goto(`${BASE_URL}${screenshot.path}`, {
        waitUntil: "networkidle",
      });

      await page.waitForTimeout(500);

      const screenshotElement = page.locator('[data-screenshot="true"]').first();

      const outputPath = path.join(OUTPUT_DIR, `${screenshot.name}@2x.png`);
      await screenshotElement.screenshot({
        path: outputPath,
        type: "png",
      });

      console.log(`Captured: ${outputPath}`);

      await context.close();
    });
  }
});

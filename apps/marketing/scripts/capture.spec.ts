import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { CANVAS, DEVICES, shotsFor, capturePath } from "../src/lib/app-store-shots";

const OUTPUT_DIR = path.join(__dirname, "..", "output");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

test.beforeAll(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

/**
 * The device frame must hold a real simulator capture — App Review guideline
 * 2.3.3 wants the app shown in actual use. Missing captures fail here rather
 * than rendering an empty frame that looks plausible in a thumbnail.
 */
test.describe("App Store screenshots", () => {
  for (const device of DEVICES) {
    const canvas = CANVAS[device];

    shotsFor(device).forEach((shot, index) => {
      test(`${device}/${index + 1}-${shot.slug}`, async ({ browser }) => {
        const source = path.join(PUBLIC_DIR, capturePath(device, shot.slug));
        expect(
          fs.existsSync(source),
          `Missing simulator capture: ${path.relative(PUBLIC_DIR, source)}. ` +
            `Record it with \`xcrun simctl io booted screenshot\` on a ${canvas.label} simulator ` +
            `running the shipping build, then re-run.`,
        ).toBe(true);

        const context = await browser.newContext({
          viewport: { width: canvas.width, height: canvas.height },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();

        await page.goto(`/screenshots/${device}/${shot.slug}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(500);

        // Numbered so the intended upload order survives a re-render — App
        // Store Connect takes them in the order you add them.
        const outputPath = path.join(OUTPUT_DIR, `${device}-${index + 1}-${shot.slug}.png`);
        await page.locator('[data-screenshot="true"]').first().screenshot({
          path: outputPath,
          type: "png",
        });

        // App Store Connect rejects anything off the required size, and a
        // silently mis-sized export is only discovered at upload.
        const { width, height } = await page
          .locator('[data-screenshot="true"]')
          .first()
          .evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
        expect({ width, height }).toEqual({ width: canvas.width, height: canvas.height });

        console.log(`Captured: ${outputPath}`);
        await context.close();
      });
    });
  }
});

import { test } from "@playwright/test";
import path from "path";

/**
 * Regenerates public/og-image.png — the default social preview for every
 * page — from the live home hero, so the card always matches the site: copy,
 * space backdrop, and the demo app window, without the navbar or the
 * testimonials. Run against a dev server:
 *
 *   bun run dev            (port 3004)
 *   bun run capture:og     (or BASE_URL=http://localhost:3004 bun run capture:og)
 *
 * Output is the Open Graph / Twitter large-card size, 1200x630, captured at
 * 2x and downsampled by the browser for crisp text.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3005";
const OUT = path.join(__dirname, "..", "public", "og-image.png");
const W = 1200;
const H = 630;

test("capture og-image.png from the home hero", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: W, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "dark");
    } catch {
      /* storage unavailable */
    }
  });
  await page.goto(BASE_URL + "/", { waitUntil: "networkidle" });
  // Give the hero exactly the card's height and centre its content in it.
  await page.addStyleTag({
    content: `.lp .hero{min-height:${H}px;display:grid;align-items:center;padding:0 !important}.lp .hero-in{width:100%}`,
  });
  await page.waitForTimeout(800);
  await page.locator(".lp .hero").screenshot({ path: OUT, type: "png" });
  await context.close();
});

/**
 * Encodes every hero backdrop variant listed in src/lib/hero-images.ts into
 * public/_marketing/hero/, so the marketing server serves static files instead
 * of running sharp per request (two 3840w AVIF encodes at once OOM-killed the
 * 512 MB machine). Runs before `next build` and `next dev`.
 *
 *   bun scripts/encode-hero.ts           skip variants newer than their inputs
 *   bun scripts/encode-hero.ts --force   re-encode everything
 *
 * Encodes one variant at a time: at build time memory matters more than speed.
 */
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { HERO_FORMATS, HERO_FRAMES, heroVariants } from "../src/lib/hero-images";

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const force = process.argv.includes("--force");

const mtimeMs = async (file: string) => (await stat(file)).mtimeMs;
const sizeOf = async (file: string) => stat(file).then((s) => s.size, () => 0);

// A change to the spec (widths, qualities) or to this script must re-encode,
// not only a change to the source image.
const [specMtime, scriptMtime] = await Promise.all([
  mtimeMs(path.join(APP_ROOT, "src/lib/hero-images.ts")),
  mtimeMs(fileURLToPath(import.meta.url)),
]);

const started = Date.now();
let encoded = 0;

for (const variant of heroVariants()) {
  const source = path.join(PUBLIC_DIR, HERO_FRAMES[variant.frame].source);
  const out = path.join(PUBLIC_DIR, variant.path);
  const inputsMtime = Math.max(await mtimeMs(source), specMtime, scriptMtime);

  if (!force && (await sizeOf(out)) > 0 && (await mtimeMs(out)) >= inputsMtime) continue;

  await mkdir(path.dirname(out), { recursive: true });
  const { quality } = HERO_FORMATS[variant.format];
  const pipeline = sharp(source).rotate().resize(variant.width, undefined, { withoutEnlargement: true });
  // Write beside the target and rename: a run killed mid-encode must not leave a
  // truncated file whose fresh mtime would make every later run skip it.
  const partial = `${out}.partial`;
  await (variant.format === "avif" ? pipeline.avif({ quality }) : pipeline.webp({ quality })).toFile(partial);
  await rename(partial, out);
  encoded++;
}

const missing = [];
for (const variant of heroVariants()) {
  if ((await sizeOf(path.join(PUBLIC_DIR, variant.path))) === 0) missing.push(variant.path);
}
if (missing.length > 0) {
  console.error(`encode-hero: ${missing.length} variant(s) missing or empty:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(`encode-hero: ${encoded} encoded, ${heroVariants().length - encoded} up to date (${Date.now() - started} ms)`);

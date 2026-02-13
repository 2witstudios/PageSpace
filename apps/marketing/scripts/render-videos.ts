#!/usr/bin/env npx ts-node
/**
 * Render Videos Script
 *
 * This script renders all marketing video compositions to MP4 files.
 *
 * Usage:
 *   pnpm run render-videos              # Render all compositions
 *   pnpm run render-videos Hero         # Render specific composition
 *   pnpm run render-videos --dark       # Render dark theme versions
 *
 * Output:
 *   Videos are rendered to public/videos/
 */

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import fs from "fs";

const COMPOSITIONS = [
  { id: "Sample", light: "Sample", dark: "SampleDark" },
  { id: "Hero", light: "Hero", dark: "HeroDark" },
];

async function renderVideo(
  bundleLocation: string,
  compositionId: string,
  outputPath: string
) {
  console.log(`Rendering ${compositionId}...`);

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
  });

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: outputPath,
    onProgress: ({ progress }) => {
      if (progress % 10 === 0) {
        process.stdout.write(`  Progress: ${Math.round(progress * 100)}%\r`);
      }
    },
  });

  console.log(`  ✓ Rendered to ${outputPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const specificComposition = args.find((arg) => !arg.startsWith("--"));
  const darkOnly = args.includes("--dark");
  const lightOnly = args.includes("--light");
  const all = !darkOnly && !lightOnly;

  // Create output directory
  const outputDir = path.join(__dirname, "../public/videos");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("Bundling Remotion project...");
  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, "../remotion/index.ts"),
    webpackOverride: (config) => config,
  });
  console.log("✓ Bundle created\n");

  const compositionsToRender = specificComposition
    ? COMPOSITIONS.filter((c) => c.id === specificComposition)
    : COMPOSITIONS;

  if (compositionsToRender.length === 0) {
    console.error(`Unknown composition: ${specificComposition}`);
    console.log(
      "Available compositions:",
      COMPOSITIONS.map((c) => c.id).join(", ")
    );
    process.exit(1);
  }

  for (const comp of compositionsToRender) {
    if (all || lightOnly) {
      await renderVideo(
        bundleLocation,
        comp.light,
        path.join(outputDir, `${comp.id.toLowerCase()}-light.mp4`)
      );
    }
    if (all || darkOnly) {
      await renderVideo(
        bundleLocation,
        comp.dark,
        path.join(outputDir, `${comp.id.toLowerCase()}-dark.mp4`)
      );
    }
  }

  console.log("\n✓ All videos rendered successfully!");
  console.log(`  Output directory: ${outputDir}`);
}

main().catch((err) => {
  console.error("Error rendering videos:", err);
  process.exit(1);
});

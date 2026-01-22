#!/usr/bin/env tsx
/**
 * Changelog Evidence Generator
 *
 * Master script that runs all evidence generation:
 * 1. generate-evidence-index.ts - Main evidence JSON
 * 2. detect-abandoned-approaches.ts - Failed experiments
 * 3. detect-multiple-attempts.ts - Retry patterns and candid messages
 * 4. track-file-evolution.ts - Per-file histories
 */

import { execSync } from "child_process";
import * as path from "path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);

function runScript(name: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running: ${name}`);
  console.log("=".repeat(60) + "\n");

  const scriptPath = path.join(scriptDir, name);

  try {
    execSync(`npx tsx "${scriptPath}"`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  } catch (error) {
    console.error(`Failed to run ${name}:`, error);
    process.exit(1);
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     PageSpace Changelog Evidence Generator               ║");
  console.log("║                                                          ║");
  console.log("║  Generating evidence from git history for:               ║");
  console.log("║  - File lifecycles and abandoned approaches              ║");
  console.log("║  - Multiple attempt patterns                             ║");
  console.log("║  - Candid commit messages                                ║");
  console.log("║  - Per-file evolution histories                          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const startTime = Date.now();

  // Run each generator
  runScript("generate-evidence-index.ts");
  runScript("detect-abandoned-approaches.ts");
  runScript("detect-multiple-attempts.ts");
  runScript("track-file-evolution.ts");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(60));
  console.log("✓ All evidence generation complete!");
  console.log(`  Total time: ${elapsed}s`);
  console.log("=".repeat(60));
  console.log("\nGenerated files:");
  console.log("  docs/changelog/evidence/");
  console.log("    ├── evidence-index.json       (main evidence database)");
  console.log("    ├── file-index.md             (index of file histories)");
  console.log("    ├── files/                    (per-file evolution docs)");
  console.log("    └── patterns/");
  console.log("        ├── abandoned-approaches.md");
  console.log("        ├── multiple-attempts.md");
  console.log("        └── candid-messages.md");
}

main().catch(console.error);

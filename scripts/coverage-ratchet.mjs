#!/usr/bin/env node

/**
 * Reads coverage-summary.json from each package and updates vitest config thresholds.
 * Run after merging a coverage PR to lock in gains.
 *
 * Usage: node scripts/coverage-ratchet.js [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const packages = [
  { name: 'apps/web', config: 'apps/web/vitest.config.ts', summary: 'apps/web/coverage/coverage-summary.json' },
  { name: 'apps/processor', config: 'apps/processor/vitest.config.ts', summary: 'apps/processor/coverage/coverage-summary.json' },
  { name: 'apps/realtime', config: 'apps/realtime/vitest.config.ts', summary: 'apps/realtime/coverage/coverage-summary.json' },
  { name: 'packages/db', config: 'packages/db/vitest.config.ts', summary: 'packages/db/coverage/coverage-summary.json' },
  { name: 'packages/lib', config: 'packages/lib/vitest.config.ts', summary: 'packages/lib/coverage/coverage-summary.json' },
];

let updated = 0;

for (const pkg of packages) {
  const summaryPath = resolve(root, pkg.summary);
  const configPath = resolve(root, pkg.config);

  if (!existsSync(summaryPath)) {
    console.log(`[skip] ${pkg.name}: no coverage-summary.json`);
    continue;
  }

  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const t = data.total;
  let config = readFileSync(configPath, 'utf8');

  // Floor to integer — ratchet only locks in whole-percent gains
  const newThresholds = {
    lines: Math.floor(t.lines.pct),
    branches: Math.floor(t.branches.pct),
    functions: Math.floor(t.functions.pct),
    statements: Math.floor(t.statements.pct),
  };

  // Match the thresholds block and replace values
  const thresholdRegex = /thresholds:\s*\{[^}]+\}/s;
  const match = config.match(thresholdRegex);

  if (!match) {
    console.log(`[skip] ${pkg.name}: no thresholds block found in vitest config`);
    continue;
  }

  // Extract current thresholds
  const currentLines = parseInt(match[0].match(/lines:\s*(\d+)/)?.[1] ?? '0');
  const currentBranches = parseInt(match[0].match(/branches:\s*(\d+)/)?.[1] ?? '0');
  const currentFunctions = parseInt(match[0].match(/functions:\s*(\d+)/)?.[1] ?? '0');
  const currentStatements = parseInt(match[0].match(/statements:\s*(\d+)/)?.[1] ?? '0');

  // Only ratchet UP, never down
  const finalThresholds = {
    lines: Math.max(currentLines, newThresholds.lines),
    branches: Math.max(currentBranches, newThresholds.branches),
    functions: Math.max(currentFunctions, newThresholds.functions),
    statements: Math.max(currentStatements, newThresholds.statements),
  };

  const changed =
    finalThresholds.lines !== currentLines ||
    finalThresholds.branches !== currentBranches ||
    finalThresholds.functions !== currentFunctions ||
    finalThresholds.statements !== currentStatements;

  if (!changed) {
    console.log(`[ok]   ${pkg.name}: thresholds already at or above current coverage`);
    continue;
  }

  const newBlock = `thresholds: {\n        lines: ${finalThresholds.lines},\n        branches: ${finalThresholds.branches},\n        functions: ${finalThresholds.functions},\n        statements: ${finalThresholds.statements},\n      }`;

  config = config.replace(thresholdRegex, newBlock);

  if (dryRun) {
    console.log(`[dry]  ${pkg.name}: would update thresholds:`);
  } else {
    writeFileSync(configPath, config);
    console.log(`[up]   ${pkg.name}: updated thresholds:`);
  }

  console.log(`         lines:      ${currentLines} -> ${finalThresholds.lines}`);
  console.log(`         branches:   ${currentBranches} -> ${finalThresholds.branches}`);
  console.log(`         functions:  ${currentFunctions} -> ${finalThresholds.functions}`);
  console.log(`         statements: ${currentStatements} -> ${finalThresholds.statements}`);
  updated++;
}

console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${updated} package(s).`);

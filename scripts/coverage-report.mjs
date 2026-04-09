#!/usr/bin/env node

/**
 * Aggregates coverage-summary.json from all packages into a unified monorepo table.
 * Run after `pnpm test:coverage` to see a combined view.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const packages = [
  { name: 'apps/web', path: 'apps/web/coverage/coverage-summary.json' },
  { name: 'apps/processor', path: 'apps/processor/coverage/coverage-summary.json' },
  { name: 'apps/realtime', path: 'apps/realtime/coverage/coverage-summary.json' },
  { name: 'packages/db', path: 'packages/db/coverage/coverage-summary.json' },
  { name: 'packages/lib', path: 'packages/lib/coverage/coverage-summary.json' },
];

const pad = (str, len) => String(str).padStart(len);

console.log('\n=== PageSpace Monorepo Coverage Report ===\n');
console.log(
  'Package'.padEnd(20),
  pad('Lines', 8),
  pad('Branch', 8),
  pad('Funcs', 8),
  pad('Stmts', 8)
);
console.log('-'.repeat(54));

let totalLines = { covered: 0, total: 0 };
let totalBranches = { covered: 0, total: 0 };
let totalFunctions = { covered: 0, total: 0 };
let totalStatements = { covered: 0, total: 0 };

for (const pkg of packages) {
  const filePath = resolve(root, pkg.path);
  if (!existsSync(filePath)) {
    console.log(pkg.name.padEnd(20), '  (no coverage data)');
    continue;
  }

  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const t = data.total;

  totalLines.covered += t.lines.covered;
  totalLines.total += t.lines.total;
  totalBranches.covered += t.branches.covered;
  totalBranches.total += t.branches.total;
  totalFunctions.covered += t.functions.covered;
  totalFunctions.total += t.functions.total;
  totalStatements.covered += t.statements.covered;
  totalStatements.total += t.statements.total;

  console.log(
    pkg.name.padEnd(20),
    pad(t.lines.pct + '%', 8),
    pad(t.branches.pct + '%', 8),
    pad(t.functions.pct + '%', 8),
    pad(t.statements.pct + '%', 8)
  );
}

console.log('-'.repeat(54));

const pct = (covered, total) => total === 0 ? '100' : ((covered / total) * 100).toFixed(2);

console.log(
  'TOTAL'.padEnd(20),
  pad(pct(totalLines.covered, totalLines.total) + '%', 8),
  pad(pct(totalBranches.covered, totalBranches.total) + '%', 8),
  pad(pct(totalFunctions.covered, totalFunctions.total) + '%', 8),
  pad(pct(totalStatements.covered, totalStatements.total) + '%', 8)
);
console.log();

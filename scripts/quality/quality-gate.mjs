#!/usr/bin/env node

/**
 * Quality gate: lint every app/package source tree against the strict rule set
 * in eslint.quality.config.mjs, compare per-file per-rule violation counts to
 * the committed quality-baseline.json, and fail on any increase.
 *
 * This is a ratchet, not a linter run: the baseline froze all pre-existing
 * debt, so the gate passes on day one and only ever fails on NEW debt. The
 * baseline file's git history is the deterministic record of refactor
 * progress — counts may only go down.
 *
 * Usage:
 *   node scripts/quality/quality-gate.mjs            # check mode (CI) — exit 1 on regression
 *   node scripts/quality/quality-gate.mjs --update   # rewrite quality-baseline.json to current state
 *
 * All comparison/serialization logic lives in ./lib.mjs (pure, tested); this
 * file owns I/O only.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import {
  countByFileAndRule,
  countSuppressions,
  diffAgainstBaseline,
  formatReport,
  serializeBaseline,
} from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const baselinePath = resolve(root, 'quality-baseline.json');
const update = process.argv.includes('--update');

// Every workspace source tree. Globs that match nothing are tolerated
// (errorOnUnmatchedPattern: false) so adding/removing an app never breaks the gate.
const TARGETS = [
  'apps/*/src/**/*.{ts,tsx,mts,cts}',
  'packages/*/src/**/*.{ts,tsx,mts,cts}',
];

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: resolve(__dirname, 'eslint.quality.config.mjs'),
  errorOnUnmatchedPattern: false,
  cache: false,
  // Inline config comments are ignored on purpose: rule counts measure the code
  // as written, independent of suppressions. Suppression directives are counted
  // separately (SUPPRESSION_RULE), so an eslint-disable can never hide debt from
  // the ratchet — it just moves it to a different ledger line.
  allowInlineConfig: false,
});

const results = await eslint.lintFiles(TARGETS);

// Suppression directives are debt too — count them per linted file so new
// eslint-disable comments ratchet exactly like new violations.
const suppressionsByFile = {};
for (const r of results) {
  const count = countSuppressions(readFileSync(r.filePath, 'utf8'));
  if (count > 0) suppressionsByFile[r.filePath] = count;
}

const toRelative = (filePath) => relative(root, filePath).split(sep).join('/');
const currentFiles = countByFileAndRule(results, suppressionsByFile, toRelative);

if (update) {
  writeFileSync(baselinePath, serializeBaseline(currentFiles));
  console.log(`Wrote ${relative(root, baselinePath)} (${results.length} files linted).`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('quality-baseline.json not found. Run `bun run quality:update` once and commit it.');
  process.exit(1);
}

const baselineFiles = JSON.parse(readFileSync(baselinePath, 'utf8')).files ?? {};
const { regressions, improvements } = diffAgainstBaseline(baselineFiles, currentFiles);

console.log(
  formatReport({ regressions, improvements, baselineFiles, currentFiles }).join('\n'),
);

process.exit(regressions.length > 0 ? 1 : 0);

#!/usr/bin/env node

/**
 * Blocking knip gate with a monotonic baseline (like coverage-ratchet.mjs, but for
 * knip's unused-file/export/dependency findings instead of coverage percentages).
 *
 * Check mode (default): fails if knip reports any issue not already in knip-baseline.json.
 * Write mode (--write): regenerates the baseline from the current (smaller-or-equal) issue
 * set. Run locally after a dead-code cleanup PR to lock in the shrink.
 *
 * Usage: node scripts/knip-ratchet.mjs [--write]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const baselinePath = resolve(root, 'knip-baseline.json');
const write = process.argv.includes('--write');

function runKnip() {
  const result = spawnSync('bunx', ['knip', '--reporter', 'json', '--no-exit-code'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    console.error(`[fail] could not run knip: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[fail] knip exited ${result.status} even with --no-exit-code:`);
    console.error(result.stderr);
    process.exit(1);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    console.error(`[fail] could not parse knip JSON output: ${err.message}`);
    console.error(result.stdout.slice(0, 2000));
    process.exit(1);
  }
}

function fingerprint(category, file, name) {
  return `${category}::${file}::${name ?? ''}`;
}

// Builds the current issue set from knip's JSON reporter output. Iterates every
// array-valued key on each issues[] entry generically (rather than a hardcoded
// category list) so a knip upgrade that adds a new issue type doesn't go ungated.
function buildFingerprints(knipOutput) {
  const fingerprints = new Set();

  for (const file of knipOutput.files ?? []) {
    fingerprints.add(fingerprint('files', file));
  }

  for (const entry of knipOutput.issues ?? []) {
    const file = entry.file;
    for (const [category, value] of Object.entries(entry)) {
      if (category === 'file' || !Array.isArray(value)) continue;
      for (const item of value) {
        const name = typeof item === 'string' ? item : item?.name;
        fingerprints.add(fingerprint(category, file, name));
      }
    }
  }

  return fingerprints;
}

function loadBaseline() {
  if (!existsSync(baselinePath)) return new Set();
  const data = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return new Set(data);
}

function groupForPrinting(fingerprints) {
  const byCategory = new Map();
  for (const fp of fingerprints) {
    const [category, file, name] = fp.split('::');
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(name ? `${file}: ${name}` : file);
  }
  return byCategory;
}

const baselineExisted = existsSync(baselinePath);
const knipOutput = runKnip();
const current = buildFingerprints(knipOutput);
const baseline = loadBaseline();

const added = [...current].filter((fp) => !baseline.has(fp));
const removed = [...baseline].filter((fp) => !current.has(fp));

if (write) {
  if (added.length > 0 && baselineExisted) {
    console.error(
      `[fail] refusing to write baseline: ${added.length} issue(s) are not in the current baseline.`
    );
    console.error('        Fix the code (or add a knip.json ignore) before running --write:\n');
    for (const [category, items] of groupForPrinting(added)) {
      console.error(`  ${category} (${items.length}):`);
      for (const item of items) console.error(`    ${item}`);
    }
    process.exit(1);
  }

  writeFileSync(baselinePath, JSON.stringify([...current].sort(), null, 2) + '\n');
  console.log(`[ok] knip-baseline.json written: ${current.size} issue(s).`);
  if (removed.length > 0) {
    console.log(`[shrink] ${removed.length} previously-baselined issue(s) resolved:`);
    for (const [category, items] of groupForPrinting(removed)) {
      console.log(`  ${category} (${items.length}):`);
      for (const item of items) console.log(`    ${item}`);
    }
  }
  process.exit(0);
}

// Check mode
if (added.length > 0) {
  console.error(
    `[fail] knip found ${added.length} new issue(s) not in knip-baseline.json:\n`
  );
  for (const [category, items] of groupForPrinting(added)) {
    console.error(`  ${category} (${items.length}):`);
    for (const item of items) console.error(`    ${item}`);
  }
  console.error(
    '\nFix these (preferred), or if genuinely unavoidable, add a knip.json ignore — do not run knip:ratchet to paper over new dead code.'
  );
  process.exit(1);
}

console.log(`[ok] knip: ${current.size} issue(s), all within baseline (${baseline.size}).`);
if (removed.length > 0) {
  console.log(
    `${removed.length} previously-baselined issue(s) no longer present — run \`bun run knip:ratchet\` to lock in the shrink.`
  );
}

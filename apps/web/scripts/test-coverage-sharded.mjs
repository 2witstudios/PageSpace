#!/usr/bin/env node

/**
 * Runs the coverage suite in sequential shards so each shard's fork pool
 * fully tears down (releasing its accumulated v8 coverage memory) before the
 * next one starts, bounding peak memory to a fraction of the whole ~930-file
 * suite instead of the whole suite at once. Single-invocation fork-count and
 * heap-ceiling tuning could not fix the coverage-run OOM/instability — see
 * vitest.config.ts's and ../../.github/workflows/ci.yml's git history for
 * the full trail of what was tried.
 *
 * Each shard disables its own threshold enforcement (VITEST_COVERAGE_SHARD
 * env var — see vitest.config.ts) since a shard's own file subset isn't the
 * right denominator for thresholds calibrated against the whole suite. Shards
 * are disjoint by TEST file, but the SOURCE files they cover can and do
 * overlap (shared utilities imported by tests in more than one shard), so
 * merging is done at the raw per-line/branch coverage level via
 * istanbul-lib-coverage — the same library istanbul/nyc use for this exact
 * problem — not by summing each shard's own summary numbers, which would be
 * wrong for any file covered by more than one shard.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import istanbulLibCoverage from 'istanbul-lib-coverage';
const { createCoverageMap } = istanbulLibCoverage;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
// 3 shards (~310 files each), then 6 (~155 each) — both still had exactly one
// shard hit the heap ceiling, just a different shard each time. Both failed
// cleanly (script caught it, exited, no hang, no runner-level instability —
// unlike every single-invocation attempt before sharding existed), so this is
// purely a calibration problem, not a structural one. Moving more decisively
// (10 shards, ~93 files each) rather than incrementing by small steps, paired
// with raising the ceiling back to 10240MB (see ci.yml) — a value already
// proven to fail cleanly/safely at default concurrency without destabilizing
// the runner, just insufficient alone before sharding existed. Combined with
// a much smaller per-shard file count, it should have real headroom now.
const SHARD_COUNT = 10;
const METRICS = ['lines', 'branches', 'functions', 'statements'];
const coverageDir = resolve(root, 'coverage');

rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(coverageDir, { recursive: true });

for (let i = 1; i <= SHARD_COUNT; i++) {
  console.log(`\n=== Coverage shard ${i}/${SHARD_COUNT} ===\n`);
  try {
    execFileSync(
      'bunx',
      [
        'vitest',
        'run',
        '--coverage',
        `--shard=${i}/${SHARD_COUNT}`,
        '--coverage.reporter=json',
        `--coverage.reportsDirectory=./coverage/shard-${i}`,
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, VITEST_COVERAGE_SHARD: '1' },
      }
    );
  } catch {
    // A shard's own tests failed (not a threshold issue — those are disabled
    // per-shard). Propagate as a real CI failure, not a stack trace dump.
    console.error(`\nShard ${i}/${SHARD_COUNT} failed.`);
    process.exit(1);
  }
}

// Merge every shard's raw coverage-final.json at the line/branch level.
// Source files covered by tests in more than one shard get their hit data
// properly unioned by istanbul-lib-coverage's merge — summing each shard's
// own precomputed summary numbers would double- or under-count those files.
const map = createCoverageMap({});
for (let i = 1; i <= SHARD_COUNT; i++) {
  const shardFinalPath = resolve(coverageDir, `shard-${i}/coverage-final.json`);
  if (!existsSync(shardFinalPath)) {
    console.error(`Missing coverage-final.json for shard ${i}: ${shardFinalPath}`);
    process.exit(1);
  }
  map.merge(JSON.parse(readFileSync(shardFinalPath, 'utf8')));
}

const allFiles = map.files();
const perFile = {};
for (const file of allFiles) {
  perFile[file] = map.fileCoverageFor(file).toSummary().toJSON();
}
const total = map.getCoverageSummary().toJSON();
const finalSummary = { total, ...perFile };
writeFileSync(resolve(coverageDir, 'coverage-summary.json'), JSON.stringify(finalSummary, null, 2));

console.log('\n=== Merged coverage summary (all shards) ===');
console.log(`  files:      ${allFiles.length}`);
console.log(`  lines:      ${total.lines.pct}%`);
console.log(`  branches:   ${total.branches.pct}%`);
console.log(`  functions:  ${total.functions.pct}%`);
console.log(`  statements: ${total.statements.pct}%`);

// Re-check the same thresholds vitest.config.ts declares, against the merged
// whole-suite result (each shard skipped its own enforcement above).
const configSource = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8');

const ratchetMatch = configSource.match(/\/\* ratchet:start \*\/([\s\S]*?)\/\* ratchet:end \*\//);
if (!ratchetMatch) {
  console.error('Could not find the ratchet:start/ratchet:end block in vitest.config.ts');
  process.exit(1);
}
const globalThresholds = {};
for (const metric of METRICS) {
  const m = ratchetMatch[1].match(new RegExp(`${metric}:\\s*(\\d+)`));
  if (!m) {
    console.error(`Could not find "${metric}" in the ratchet block`);
    process.exit(1);
  }
  globalThresholds[metric] = Number(m[1]);
}

const globEntryRegex = /'([^']+)':\s*\{\s*lines:\s*(\d+),\s*branches:\s*(\d+),\s*functions:\s*(\d+),\s*statements:\s*(\d+)\s*\}/g;
const globThresholds = [];
let m;
while ((m = globEntryRegex.exec(configSource))) {
  globThresholds.push({
    glob: m[1],
    lines: Number(m[2]),
    branches: Number(m[3]),
    functions: Number(m[4]),
    statements: Number(m[5]),
  });
}

// Only the simple `dir/*.ext` / literal-path shapes actually used in this
// config's thresholds — not a general glob implementation.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

let failed = false;

for (const metric of METRICS) {
  if (total[metric].pct < globalThresholds[metric]) {
    console.error(
      `ERROR: Coverage for ${metric} (${total[metric].pct}%) does not meet global threshold (${globalThresholds[metric]}%)`
    );
    failed = true;
  }
}

for (const { glob, ...thresholds } of globThresholds) {
  const regex = globToRegExp(glob);
  const matchingFiles = allFiles.filter((f) => regex.test(relative(root, f)));
  if (matchingFiles.length === 0) {
    console.error(`ERROR: No files matched threshold glob "${glob}"`);
    failed = true;
    continue;
  }
  const globMap = createCoverageMap({});
  for (const file of matchingFiles) {
    globMap.addFileCoverage(map.fileCoverageFor(file));
  }
  const globTotal = globMap.getCoverageSummary().toJSON();
  for (const metric of METRICS) {
    if (globTotal[metric].pct < thresholds[metric]) {
      console.error(
        `ERROR: Coverage for ${metric} (${globTotal[metric].pct}%) does not meet "${glob}" threshold (${thresholds[metric]}%)`
      );
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('\nAll coverage thresholds met.\n');

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
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, globSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import istanbulLibCoverage from 'istanbul-lib-coverage';
const { createCoverageMap } = istanbulLibCoverage;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
// 3, 6, 10, 20, and 40 shards (~310/155/93/46/23 files each) all still had
// exactly one shard hit the heap ceiling — always a CLEAN failure (script
// catches it, exits, no hang, no runner-level instability, at the stable
// 8192MB ceiling; see ci.yml's history for why that value specifically is
// never raised). The failing shard's fraction through the run stayed
// suspiciously consistent across shard counts (~0.55-0.67 each time) —
// doubling shard count preserved the SAME relative position of trouble,
// which rules out "too many files accumulating" (a smaller shard at that
// same position should then have succeeded) and points to vitest's
// `--shard` flag splitting the sorted file list into plain CONTIGUOUS
// ranges: a genuinely dense, heavy cluster of files (e.g.
// src/lib/ai/core/__tests__/ alone is 66 of ~930 total, each pulling in
// substantial shared AI-orchestration infrastructure) sits together in that
// range no matter how finely you slice around it — smaller shards just
// isolate the SAME cluster into a smaller box, they don't split it apart.
//
// Fixed the actual mechanism instead of keeping the shard count as another
// guess to escalate: this script enumerates and sorts the file list itself,
// then distributes it into shards ROUND-ROBIN (file at sorted index i goes
// to shard i % SHARD_COUNT) instead of trusting `--shard` to do a
// contiguous split. Any dense cluster in the sorted order is now spread
// evenly across every shard rather than concentrated in whichever one
// happens to cover that range.
const SHARD_COUNT = 20;
const METRICS = ['lines', 'branches', 'functions', 'statements'];
const coverageDir = resolve(root, 'coverage');

rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(coverageDir, { recursive: true });

const allTestFiles = globSync('src/**/*.{test,spec}.{js,ts,tsx}', { cwd: root }).sort();
const shards = Array.from({ length: SHARD_COUNT }, () => []);
allTestFiles.forEach((file, i) => shards[i % SHARD_COUNT].push(file));

// Even with files evenly interleaved (verified locally — the 66-file
// src/lib/ai/core cluster now lands 3-4 per shard, not up to 66 in one),
// some CI run still hits the heap ceiling on some shard at roughly the same
// job-wide fraction regardless of shard count or file composition — which
// argues against a fixed "this exact file set is too heavy" cause and for a
// marginal, close-to-the-ceiling workload where GC/scheduling variance
// between otherwise-identical runs decides pass or fail. A shard that
// crashes gets retried (fresh process, same files, same ceiling) before
// failing the whole run — if the crash were fully deterministic for that
// exact file set this would just fail again quickly at low added cost; if
// it's marginal, a retry resolves it outright.
const MAX_ATTEMPTS_PER_SHARD = 3;

for (let i = 1; i <= SHARD_COUNT; i++) {
  const files = shards[i - 1];
  console.log(`\n=== Coverage shard ${i}/${SHARD_COUNT} (${files.length} files) ===\n`);
  if (files.length === 0) continue;
  let succeeded = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SHARD && !succeeded; attempt++) {
    if (attempt > 1) {
      console.log(`\n--- Retrying shard ${i}/${SHARD_COUNT} (attempt ${attempt}/${MAX_ATTEMPTS_PER_SHARD}) ---\n`);
    }
    try {
      execFileSync(
        'bunx',
        [
          'vitest',
          'run',
          '--coverage',
          '--coverage.reporter=json',
          `--coverage.reportsDirectory=./coverage/shard-${i}`,
          ...files,
        ],
        {
          cwd: root,
          stdio: 'inherit',
          env: { ...process.env, VITEST_COVERAGE_SHARD: '1' },
        }
      );
      succeeded = true;
    } catch {
      if (attempt === MAX_ATTEMPTS_PER_SHARD) {
        // A shard's own tests failed (not a threshold issue — those are
        // disabled per-shard). Propagate as a real CI failure, not a stack
        // trace dump.
        console.error(`\nShard ${i}/${SHARD_COUNT} failed after ${MAX_ATTEMPTS_PER_SHARD} attempts.`);
        process.exit(1);
      }
    }
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

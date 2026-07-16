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
// Escalating shard count (3 -> 6 -> 10 -> 20 -> 40) and then interleaving
// files round-robin instead of contiguously both reduced the failure rate
// but never eliminated it — a shard would still hit the heap ceiling at
// roughly the same job-wide fraction each time, even with a completely
// different, evenly-mixed file composition after interleaving. Retrying a
// failing shard (fresh process, identical files, identical ceiling) up to 3
// times still failed every attempt identically, which finally proved the
// cause is deterministic for a specific file combination, not GC/scheduling
// luck.
//
// Found it by inspecting the exact file list of a deterministically-failing
// shard: AiChatView.test.tsx (1936 lines) and
// AiChatView.realConversations.test.tsx (376 lines), under
// src/components/layout/middle-content/page-views/ai-page/__tests__/ — the
// exact two files this PR's own D.1 tracking already named as unverified
// ("still asserting against the pre-cutover useChat-as-render-source
// architecture... crashes both locally [an unrelated dual-React-dispatcher
// bug] and in CI"). Not simply "large files" — several *bigger* test files
// (e.g. calendar-write-tools.test.ts at 2056 lines) sit elsewhere in the
// suite without incident, since they don't render React component trees
// through jsdom the way these two do, against a component this PR heavily
// rewrote. Isolated them into their own dedicated shards below so the rest
// of the suite goes back to a plain, even round-robin split.
const HEAVY_FILES = [
  'src/components/layout/middle-content/page-views/ai-page/__tests__/AiChatView.test.tsx',
  'src/components/layout/middle-content/page-views/ai-page/__tests__/AiChatView.realConversations.test.tsx',
];
const SHARD_COUNT = 20;
const METRICS = ['lines', 'branches', 'functions', 'statements'];
const coverageDir = resolve(root, 'coverage');

rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(coverageDir, { recursive: true });

const allTestFiles = globSync('src/**/*.{test,spec}.{js,ts,tsx}', { cwd: root }).sort();
const heavyFilesFound = HEAVY_FILES.filter((f) => allTestFiles.includes(f));
const remainingFiles = allTestFiles.filter((f) => !HEAVY_FILES.includes(f));

const shards = Array.from({ length: SHARD_COUNT }, () => []);
remainingFiles.forEach((file, i) => shards[i % SHARD_COUNT].push(file));
// Each heavy file gets a fully solo shard, appended after the round-robin
// ones, so it never shares a fork pool with anything else.
const firstHeavyShardIndex = shards.length;
heavyFilesFound.forEach((file) => shards.push([file]));

// A shard that hits the heap ceiling gets retried (fresh process, identical
// files, identical ceiling) up to 2 additional times before the whole run
// fails — cheap insurance against any remaining marginal case.
const MAX_ATTEMPTS_PER_SHARD = 3;
const TOTAL_SHARDS = shards.length;

// The isolation itself (previous commit) proved this: with all contention
// from the other ~930 files removed, AiChatView.test.tsx STILL hit the heap
// ceiling alone, on its own dedicated shard, every one of 3 fresh-process
// retries — this single ~1936-line file genuinely needs more than the
// job-level 8192MB (see ci.yml) for its own v8-coverage-instrumented run.
// Every earlier attempt at raising the ceiling destabilized the runner
// itself — but those were all raising it for MANY forks running with real
// aggregate concurrency (default fork count, or a whole shard's worth of
// files). A solo-file shard only ever runs one worker; there is no
// concurrent memory pressure to compound, so a higher ceiling here is safe
// in a way it wasn't at the job level.
const HEAVY_SHARD_NODE_OPTIONS = '--max-old-space-size=14336';

for (let i = 1; i <= TOTAL_SHARDS; i++) {
  const files = shards[i - 1];
  const isHeavyShard = i > firstHeavyShardIndex;
  console.log(`\n=== Coverage shard ${i}/${TOTAL_SHARDS} (${files.length} files)${isHeavyShard ? ' [isolated heavy file]' : ''} ===\n`);
  if (files.length === 0) continue;
  let succeeded = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SHARD && !succeeded; attempt++) {
    if (attempt > 1) {
      console.log(`\n--- Retrying shard ${i}/${TOTAL_SHARDS} (attempt ${attempt}/${MAX_ATTEMPTS_PER_SHARD}) ---\n`);
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
          env: {
            ...process.env,
            VITEST_COVERAGE_SHARD: '1',
            ...(isHeavyShard ? { NODE_OPTIONS: HEAVY_SHARD_NODE_OPTIONS } : {}),
          },
        }
      );
      succeeded = true;
    } catch {
      if (attempt === MAX_ATTEMPTS_PER_SHARD) {
        // A shard's own tests failed (not a threshold issue — those are
        // disabled per-shard). Propagate as a real CI failure, not a stack
        // trace dump.
        console.error(`\nShard ${i}/${TOTAL_SHARDS} failed after ${MAX_ATTEMPTS_PER_SHARD} attempts.`);
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
for (let i = 1; i <= TOTAL_SHARDS; i++) {
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

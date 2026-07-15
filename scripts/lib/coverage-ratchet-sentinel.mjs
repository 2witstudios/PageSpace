/**
 * Pure, unit-testable pieces of scripts/coverage-ratchet.mjs's threshold-block
 * matching, rewriting, and pre-write syntax check.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Markers must occupy their own line (only leading/trailing whitespace besides
// the marker) — real usage always looks like that, whereas a prose comment
// mentioning the markers (e.g. "the /* ratchet:start */.../* ratchet:end */
// markers below are load-bearing") has other text sharing the line and is
// correctly rejected.
export const SENTINEL_REGEX = /^([ \t]*)\/\* ratchet:start \*\/[ \t]*\r?\n[\s\S]*?^[ \t]*\/\* ratchet:end \*\/[ \t]*\r?$/m;

export const PLAIN_REGEX = /thresholds:\s*\{[^}]+\}/s;

// Match the sentinel-marked ratchet region first — packages with per-glob
// threshold keys after the four ratcheted scalars (e.g. apps/web's 100% gates
// on new pure modules) would otherwise have `[^}]+` stop at the glob
// sub-objects' first `}`, truncating the match and corrupting the rewrite.
// Fall back to the plain block match for packages with no sentinel, so
// processor/realtime/db/lib keep working unchanged.
export function matchThresholdBlock(config) {
  const sentinelMatch = config.match(SENTINEL_REGEX);
  if (sentinelMatch) {
    return { match: sentinelMatch, regex: SENTINEL_REGEX, isSentinel: true };
  }
  const plainMatch = config.match(PLAIN_REGEX);
  if (plainMatch) {
    return { match: plainMatch, regex: PLAIN_REGEX, isSentinel: false };
  }
  return null;
}

// The sentinel rewrite preserves everything after `ratchet:end` (the per-glob
// 100% keys) and the start marker's original indentation — only the four
// ratcheted scalars inside the markers are replaced.
export function buildThresholdBlock({ isSentinel, indent, thresholds }) {
  const { lines, branches, functions, statements } = thresholds;
  return isSentinel
    ? `${indent}/* ratchet:start */\n        lines: ${lines},\n        branches: ${branches},\n        functions: ${functions},\n        statements: ${statements},\n        /* ratchet:end */`
    : `thresholds: {\n        lines: ${lines},\n        branches: ${branches},\n        functions: ${functions},\n        statements: ${statements},\n      }`;
}

// Writes `source` to a throwaway .mjs file and runs `node --check` on it —
// catches any rewrite that produces unparseable output (e.g. a sentinel match
// landing mid-comment/mid-token) before it ever reaches disk, rather than
// trusting the regex match alone.
export function assertValidSyntax(source, label, tmpDir) {
  const checkPath = resolve(tmpDir, `.coverage-ratchet-check-${process.pid}.mjs`);
  writeFileSync(checkPath, source);
  try {
    execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`${label}: rewritten config fails a syntax check — refusing to write.\n${err.stderr?.toString() ?? err.message}`);
  } finally {
    unlinkSync(checkPath);
  }
}

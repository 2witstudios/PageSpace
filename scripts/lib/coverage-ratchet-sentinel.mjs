/**
 * Pure, unit-testable pieces of scripts/coverage-ratchet.mjs's threshold-block
 * matching, rewriting, and pre-write syntax check.
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Markers must occupy their own line (only leading/trailing whitespace besides
// the marker) — real usage always looks like that, whereas a prose comment
// mentioning the markers (e.g. "the /* ratchet:start */.../* ratchet:end */
// markers below are load-bearing") has other text sharing the line and is
// correctly rejected.
export const SENTINEL_REGEX = /^([ \t]*)\/\* ratchet:start \*\/[ \t]*\n[\s\S]*?^[ \t]*\/\* ratchet:end \*\/[ \t]*$/m;
const SENTINEL_REGEX_GLOBAL = new RegExp(SENTINEL_REGEX.source, `${SENTINEL_REGEX.flags}g`);

export const PLAIN_REGEX = /thresholds:\s*\{[^}]+\}/s;

// Match the sentinel-marked ratchet region first — packages with per-glob
// threshold keys after the four ratcheted scalars (e.g. apps/web's 100% gates
// on new pure modules) would otherwise have `[^}]+` stop at the glob
// sub-objects' first `}`, truncating the match and corrupting the rewrite.
// Fall back to the plain block match for packages with no sentinel, so
// processor/realtime/db/lib keep working unchanged.
//
// Two "refuse to guess" guards beyond the line-anchoring above:
//  - More than one well-formed sentinel block in the same file is ambiguous
//    (which one is real?) — error instead of silently taking the first match.
//  - Marker text present but NOT forming a well-formed block (e.g. an
//    autoformatter appends a trailing comment to the `ratchet:end` line) must
//    NOT silently fall back to the plain match — that fallback is only safe
//    for configs that never intended to use a sentinel at all, and applying
//    it to a malformed sentinel reproduces the original truncation bug on
//    apps/web's per-glob keys.
export function matchThresholdBlock(config) {
  const sentinelSpans = config.match(SENTINEL_REGEX_GLOBAL);
  if (sentinelSpans && sentinelSpans.length > 1) {
    throw new Error(`found ${sentinelSpans.length} ratchet:start/ratchet:end sentinel blocks — expected at most one; refusing to guess which is real`);
  }

  const sentinelMatch = config.match(SENTINEL_REGEX);
  if (sentinelMatch) {
    return { match: sentinelMatch, regex: SENTINEL_REGEX, isSentinel: true, indent: sentinelMatch[1] };
  }

  if (config.includes('ratchet:start') || config.includes('ratchet:end')) {
    throw new Error('found "ratchet:start"/"ratchet:end" marker text that is not a well-formed sentinel block (each marker must occupy its own line) — refusing to fall back to the plain thresholds match, which would corrupt the per-glob keys after it');
  }

  const plainMatch = config.match(PLAIN_REGEX);
  if (plainMatch) {
    return { match: plainMatch, regex: PLAIN_REGEX, isSentinel: false, indent: '' };
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

// Extracts the current numeric thresholds from a matched block's text.
export function parseThresholds(matchText) {
  return {
    lines: parseInt(matchText.match(/lines:\s*(\d+)/)?.[1] ?? '0'),
    branches: parseInt(matchText.match(/branches:\s*(\d+)/)?.[1] ?? '0'),
    functions: parseInt(matchText.match(/functions:\s*(\d+)/)?.[1] ?? '0'),
    statements: parseInt(matchText.match(/statements:\s*(\d+)/)?.[1] ?? '0'),
  };
}

// Writes `source` to a throwaway .mjs file (in the OS temp dir, never the
// repo) and runs `node --check` on it — catches any rewrite that produces
// unparseable output (e.g. a sentinel match landing mid-comment/mid-token)
// before it ever reaches disk, rather than trusting the regex match alone.
export function assertValidSyntax(source, label) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-ratchet-check-'));
  const checkPath = join(dir, 'check.mjs');
  try {
    writeFileSync(checkPath, source);
    execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`${label}: rewritten config fails a syntax check — refusing to write.\n${err.stderr?.toString() ?? err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

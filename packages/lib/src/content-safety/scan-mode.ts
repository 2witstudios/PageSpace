/**
 * Publish-gate configuration, resolved once from the environment by a pure
 * function. The env-reading edge is `resolveScanConfigFromEnv`.
 *
 * - On-prem is always `off`: it cannot call an external vendor. Tenant behaves
 *   exactly like cloud (never gate this on `!isCloud()`).
 * - `CONTENT_SCAN_MODE` defaults to `off`. An unrecognised value is treated as
 *   `enforce`: someone meant to turn scanning on, and a typo must not quietly
 *   publish unscanned files. It is reported as a problem.
 * - `enforce` with no vendor key fails closed: nothing is promoted.
 */

import { isOnPrem } from '../deployment-mode';

export type ScanModeSetting = 'off' | 'shadow' | 'enforce';

export type ScanConfigProblem = 'missing_key' | 'invalid_mode';

export interface ScanGateConfig {
  mode: ScanModeSetting;
  /** A vendor key is present, so a scanner can be built. */
  scannerConfigured: boolean;
  problems: ScanConfigProblem[];
  /** How long a `clean` verdict is trusted before the hash is scanned again. Hash lists grow. */
  verdictTtlMs: number;
  /** Deadline for one scan; a slower scan is an error (held under enforce, retried on republish). */
  timeoutMs: number;
  /** Largest file sent to the scanner. A larger image or video is an error, not a pass. */
  maxBytes: number;
  /** Classifier score at or above which a file is flagged for review. */
  flagThreshold: number;
  /** Count matches against the vendor's test lists as real (staging only). */
  includeTestSets: boolean;
}

export const DEFAULT_VERDICT_TTL_DAYS = 30;
export const DEFAULT_SCAN_TIMEOUT_MS = 10_000;
export const DEFAULT_SCAN_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_FLAG_THRESHOLD = 0.9;

type Env = Record<string, string | undefined>;

function positiveNumber(raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** Pure: the gate's configuration for an environment. `onPrem` comes from `isOnPrem()`. */
export function resolveScanConfig(env: Env, { onPrem }: { onPrem: boolean }): ScanGateConfig {
  const problems: ScanConfigProblem[] = [];
  const raw = env.CONTENT_SCAN_MODE?.trim().toLowerCase();
  let mode: ScanModeSetting;
  if (onPrem) {
    mode = 'off';
  } else if (!raw || raw === 'off') {
    mode = 'off';
  } else if (raw === 'shadow' || raw === 'enforce') {
    mode = raw;
  } else {
    mode = 'enforce';
    problems.push('invalid_mode');
  }

  const scannerConfigured = Boolean(env.HIVE_API_KEY?.trim());
  if (mode !== 'off' && !scannerConfigured) problems.push('missing_key');

  const threshold = positiveNumber(env.CONTENT_SCAN_FLAG_THRESHOLD, DEFAULT_FLAG_THRESHOLD, 1);

  return {
    mode,
    scannerConfigured: mode !== 'off' && scannerConfigured,
    problems,
    verdictTtlMs: positiveNumber(env.CONTENT_SCAN_VERDICT_TTL_DAYS, DEFAULT_VERDICT_TTL_DAYS, 365) * 24 * 60 * 60 * 1000,
    timeoutMs: positiveNumber(env.CONTENT_SCAN_TIMEOUT_MS, DEFAULT_SCAN_TIMEOUT_MS, 120_000),
    maxBytes: positiveNumber(env.CONTENT_SCAN_MAX_BYTES, DEFAULT_SCAN_MAX_BYTES, 500 * 1024 * 1024),
    flagThreshold: threshold,
    includeTestSets: env.HIVE_INCLUDE_TEST_MATCHES === 'true',
  };
}

export function resolveScanConfigFromEnv(env: Env = process.env): ScanGateConfig {
  return resolveScanConfig(env, { onPrem: isOnPrem() });
}

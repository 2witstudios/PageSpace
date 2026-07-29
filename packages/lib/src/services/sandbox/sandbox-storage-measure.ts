/**
 * Opportunistic storage measurement for agent-session Sprites.
 *
 * The platform bills the bytes a sandbox has ACTUALLY written to its persistent
 * filesystem (TRIM-friendly — deleting files lowers the bill), NOT the
 * provisioned volume size. To bill measured usage the storage reconcile cron
 * needs a persisted byte figure on `agent_sessions` — but it must NEVER wake a
 * hibernating Sprite to get one (that would recreate the keep-awake billing
 * bug). So measurement is captured HERE, opportunistically, only while a Sprite
 * is ALREADY awake for real work, and throttled so a burst of real work costs at
 * most one `du -sxB1` per session per window.
 *
 * Without this wiring `storageMeasuredBytes` has no writer at all: every session
 * prices at the never-measured 0 floor while the reconcile still advances its
 * watermark, permanently discarding each unmeasured interval. (This module is the
 * agent-session successor to the machine-tree `machine-storage-measure.ts` that
 * the Phase 8 teardown removed along with its tables.)
 *
 * Pure core (parse/throttle) + a thin DI'd shell (`refreshSessionStorageMeasurement`)
 * that runs one `du` through an injected handle and persists via an injected
 * writer — unit-testable against a fake handle with zero real Sprite calls.
 */

import type { SandboxHandle } from './sandbox-host';
import { SANDBOX_ROOT } from './sandbox-paths';

/** Parse a non-negative integer env override; fall back on absence/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

/**
 * How stale a measurement may get before a real-work wake re-measures. At most
 * one `du` per session per window even under a burst of provisions. Default 1h,
 * env-tunable. Deliberately independent of the reconcile cadence: measurement
 * rides on real wakes, the cron only reads what is persisted.
 */
export const SESSION_STORAGE_MEASUREMENT_THROTTLE_MS = envInt(
  'AGENT_SESSION_STORAGE_MEASURE_THROTTLE_MS',
  60 * 60 * 1000,
);

/**
 * The subtree whose written bytes we bill. Measured with `du` rather than `df`
 * of the mount: `df` would also count the read-only OS/base-image bytes when the
 * workspace lives on the root overlay, over-billing every session by the image
 * size — precisely the "bill the allocation, not what was written" bug. Bytes
 * written OUTSIDE this subtree (e.g. package caches under $HOME) go uncounted: a
 * deliberate conservative under-count, consistent with the never-measured 0 floor.
 */
export const SESSION_STORAGE_MEASURE_PATH = SANDBOX_ROOT;

/**
 * Wall-clock cap on the measurement exec. `du -sxB1` walks the subtree, so it is
 * not instant on a large checkout; generous for a normal tree yet bounded so a
 * pathological one cannot run unbounded. On expiry the driver kills `du` and the
 * run fails → nothing persisted, retried next window.
 */
const MEASURE_EXEC_TIMEOUT_MS = 20_000;

/**
 * Pure: parse `du -sxB1 <path>` output → used bytes. `du -s … -B1` prints a
 * single summary line `"<bytes>\t<path>"` reporting ACTUAL allocated bytes (not
 * `-b`/apparent size, which would bill a sparse 100GB file occupying 1GB of real
 * blocks as 100GB). Returns null for empty/malformed output (caller persists
 * nothing).
 */
export function parseDuBytes(stdout: string): number | null {
  const firstLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return null;
  // Leading token is the byte count; the rest is the path (may contain spaces).
  const token = firstLine.split(/\s+/, 1)[0];
  if (!/^\d+$/.test(token)) return null;
  const bytes = Number(token);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return bytes;
}

/** Pure throttle decision: measure if never measured, or the last measurement is at least `throttleMs` old. */
export function shouldRefreshMeasurement(input: {
  lastMeasuredAt: Date | null;
  now: Date;
  throttleMs: number;
}): boolean {
  const { lastMeasuredAt, now, throttleMs } = input;
  if (lastMeasuredAt === null) return true;
  return now.getTime() - lastMeasuredAt.getTime() >= throttleMs;
}

export type PersistSessionStorageMeasurement = (input: {
  /** The `agent_sessions` PK (≡ conversationId) whose row receives the measurement. */
  sessionId: string;
  measuredBytes: number;
  measuredAt: Date;
}) => Promise<void>;

export interface RefreshSessionStorageMeasurementInput {
  /** An ALREADY-AWAKE sandbox handle (real work just happened on it) — measurement never provisions or wakes. */
  handle: Pick<SandboxHandle, 'exec'>;
  sessionId: string;
  /** Last persisted measurement time for this session (null = never measured). */
  lastMeasuredAt: Date | null;
  now: Date;
  throttleMs?: number;
  measurePath?: string;
  persist: PersistSessionStorageMeasurement;
}

export interface RefreshSessionStorageMeasurementResult {
  measured: boolean;
  bytes?: number;
}

/**
 * Opportunistically measure and persist a session's used storage bytes IF the
 * throttle window has elapsed. Fully non-fatal: an exec throw or unparseable
 * output leaves the last good measurement untouched and returns
 * `{ measured: false }`. Runs at most one `du -sxB1` per call.
 *
 * `du -sxB1 <path>`: `-s` summary, `-x` stay on one filesystem, `-B1` report
 * ACTUAL allocated bytes, `--` so a path starting with `-` is never read as a
 * flag.
 */
export async function refreshSessionStorageMeasurement(
  input: RefreshSessionStorageMeasurementInput,
): Promise<RefreshSessionStorageMeasurementResult> {
  const throttleMs = input.throttleMs ?? SESSION_STORAGE_MEASUREMENT_THROTTLE_MS;
  if (!shouldRefreshMeasurement({ lastMeasuredAt: input.lastMeasuredAt, now: input.now, throttleMs })) {
    return { measured: false };
  }

  const path = input.measurePath ?? SESSION_STORAGE_MEASURE_PATH;
  let run: { exitCode: number; stdout: string; stderr: string };
  try {
    run = await input.handle.exec({ cmd: 'du', args: ['-sxB1', '--', path], timeoutMs: MEASURE_EXEC_TIMEOUT_MS });
  } catch {
    // Best-effort — a dead/unreachable sandbox must never break the real work
    // that woke it.
    return { measured: false };
  }

  // Trust any PARSEABLE total, even on a non-zero exit. `du -s` always prints a
  // cumulative total of what it COULD read; a non-zero exit only means it
  // skipped unreadable entries, so the printed total is a conservative LOWER
  // BOUND, never garbage. Persisting it beats the alternative: a permanently
  // unreadable subtree would otherwise leave a genuinely large footprint billing
  // the 0 floor forever AND re-walk the tree on every wake for the whole window.
  const bytes = parseDuBytes(run.stdout);
  if (bytes === null) return { measured: false };

  await input.persist({ sessionId: input.sessionId, measuredBytes: bytes, measuredAt: input.now });
  return { measured: true, bytes };
}

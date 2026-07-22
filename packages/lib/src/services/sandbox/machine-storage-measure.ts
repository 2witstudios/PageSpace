/**
 * Opportunistic storage measurement (Sprites Platform Alignment 6-1).
 *
 * The platform bills for the bytes a machine has ACTUALLY written to its
 * persistent filesystem (TRIM-friendly — deleting files lowers the bill), NOT
 * the provisioned volume size (docs.sprites.dev/concepts/lifecycle). To bill
 * measured usage the reconcile cron needs a persisted byte figure — but it must
 * NEVER wake a paused sprite to get one (that would recreate the Phase-3
 * keep-awake billing bug). So measurement is captured HERE, opportunistically,
 * only while a sprite is ALREADY awake for real work (agent tool run today; any
 * other genuine wake path may call in too), and throttled so a burst of real
 * work costs at most one `du -sxB1` of the workspace per machine per window.
 *
 * Pure core (parse/convert/throttle) + a thin DI'd shell (`refreshStorageMeasurement`)
 * that runs one `du -sxB1` through an injected `MachineHandle.exec` and persists
 * via an injected writer — unit-tested against a fake handle with zero real
 * sprite calls.
 *
 * The HOT (NVMe cache) / COLD (durable object store) layers the platform keeps
 * under the filesystem are infra, not separately-billed tiers, so a single
 * used-bytes figure is the right quantity to meter; if the API later exposes a
 * per-tier split, that's a follow-up (see the leaf's Out-of-scope).
 */

import type { MachineHandle } from './machine-host';
import type { StorageSubject } from './machine-storage-attribution';
import { SANDBOX_ROOT } from './sandbox-paths';

/** Parse a non-negative integer env override; fall back on absence/garbage (mirrors credit-pricing.ts). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

/**
 * How stale a measurement may get before a real-work wake re-measures. At most
 * one `df` per machine per window even under a burst of real work. Default 1h,
 * env-tunable. Kept independent of the reconcile cadence: measurement rides on
 * real wakes, the cron only reads what's persisted.
 */
export const STORAGE_MEASUREMENT_THROTTLE_MS = envInt('MACHINE_STORAGE_MEASURE_THROTTLE_MS', 60 * 60 * 1000);

/**
 * The workspace SUBTREE whose written bytes we bill. We measure this subtree
 * (`du`) rather than the whole filesystem (`df`) on purpose: `df` of the mount
 * containing the workspace would also count the read-only OS/base-image bytes if
 * the workspace is a directory on the root overlay rather than a dedicated
 * mount — over-billing every machine by the base-image size, which is exactly
 * the "bill the allocation, not what was written" bug this leaf removes. `du` of
 * the workspace counts only what the workload actually wrote. Trade-off: bytes a
 * workload writes OUTSIDE the workspace (e.g. package caches under $HOME) are not
 * counted — a deliberate conservative under-count, consistent with the
 * never-measured 0 floor; revisit if the platform exposes exact per-volume usage.
 */
export const STORAGE_MEASURE_PATH = SANDBOX_ROOT;

/**
 * Wall-clock cap on the measurement exec. `du -sxB1` walks the workspace subtree,
 * so it is not instant on a large checkout; this is generous enough for a normal
 * tree yet bounded so a pathological one can't run unbounded. On expiry the
 * driver SIGKILLs `du` and the run fails → no persist (retried next window).
 */
const MEASURE_EXEC_TIMEOUT_MS = 20_000;

/**
 * Pure: parse `du -sxB1 <path>` output → used bytes. `du -s … B1` prints a single
 * summary line `"<bytes>\t<path>"` — the ACTUAL allocated disk usage in bytes (NOT
 * `-b`/apparent size, which would bill a sparse 100GB file that occupies 1GB of
 * real blocks as 100GB). The leading integer is the total. Returns null for empty
 * / malformed output (caller persists nothing).
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

/**
 * Pure: bytes → DECIMAL gigabytes (÷1e9), matching how the platform expresses
 * its allocation ("100 GB") and its per-GB-month rate — NOT binary GiB. Invalid
 * or non-positive input floors to 0.
 */
export function bytesToGB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / 1_000_000_000;
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

export type PersistStorageMeasurement = (input: {
  /** WHICH filesystem was measured — selects the row the writer updates (see machine-storage-attribution.ts). */
  subject: StorageSubject;
  measuredBytes: number;
  measuredAt: Date;
}) => Promise<void>;

export interface RefreshStorageMeasurementInput {
  /** An ALREADY-AWAKE machine handle (real work is happening on it) — measurement never provisions/wakes. */
  handle: Pick<MachineHandle, 'exec'>;
  /**
   * The filesystem being measured: a Machine's own Sprite or a branch-terminal's
   * separate one. Only ever decides WHERE the bytes are persisted — who pays is
   * resolved from the same subject at billing time, never here.
   */
  subject: StorageSubject;
  /** Last persisted measurement time for this subject (null = never measured). */
  lastMeasuredAt: Date | null;
  now: Date;
  throttleMs?: number;
  measurePath?: string;
  persist: PersistStorageMeasurement;
}

export interface RefreshStorageMeasurementResult {
  measured: boolean;
  bytes?: number;
}

/**
 * Opportunistically measure and persist a machine's used storage bytes IF the
 * throttle window has elapsed. Fully non-fatal: an exec throw or unparseable
 * output leaves the last good measurement untouched and returns
 * `{ measured: false }`; a parseable total is persisted even on a non-zero `du`
 * exit (see below). Runs at most one `du -sxB1` per call.
 *
 * `du -sxB1 <path>`: `-s` summary, `-x` stay on one filesystem (don't descend
 * into other mounts), `-B1` report ACTUAL allocated bytes (not `-b`/apparent
 * size), `--` so a path starting with `-` is never read as a flag. The spawned
 * `du` runs as its own process on the VM, so it does not serialize with the
 * primary op that woke the sprite.
 */
export async function refreshStorageMeasurement(
  input: RefreshStorageMeasurementInput,
): Promise<RefreshStorageMeasurementResult> {
  const throttleMs = input.throttleMs ?? STORAGE_MEASUREMENT_THROTTLE_MS;
  if (!shouldRefreshMeasurement({ lastMeasuredAt: input.lastMeasuredAt, now: input.now, throttleMs })) {
    return { measured: false };
  }

  const path = input.measurePath ?? STORAGE_MEASURE_PATH;
  let run: { exitCode: number; stdout: string; stderr: string };
  try {
    run = await input.handle.exec({ cmd: 'du', args: ['-sxB1', '--', path], timeoutMs: MEASURE_EXEC_TIMEOUT_MS });
  } catch {
    // Measurement is best-effort — a dead/unreachable sprite must never break
    // the real work that woke it.
    return { measured: false };
  }

  // Trust any PARSEABLE total, even on a non-zero exit. `du -s` always prints a
  // valid cumulative total of what it COULD read; a non-zero exit only means it
  // skipped some unreadable entries, so the printed total is a conservative
  // LOWER BOUND (never garbage), not an over-count. Persisting it is strictly
  // better than the alternative of never persisting: a permanently-unreadable
  // subtree (chmod 000, a root-owned path) would otherwise leave a genuinely
  // large footprint billing the 0 floor / a stale value forever, AND — because
  // the caller only caches on `measured` — turn every tool op into a fresh full
  // `du` walk of the live machine for the whole window. A slight under-count
  // (missing only the unreadable part, which self-corrects once readable) is the
  // right conservative trade-off, consistent with the never-measured 0 floor.
  //
  // A truly failed measurement — exec threw (handled above) or stdout has no
  // numeric total (empty / error-only output) — returns not-measured so the
  // caller leaves the page retryable instead of caching a bad value.
  const bytes = parseDuBytes(run.stdout);
  if (bytes === null) return { measured: false };

  await input.persist({ subject: input.subject, measuredBytes: bytes, measuredAt: input.now });
  return { measured: true, bytes };
}

/**
 * Opportunistic storage measurement (Sprites Platform Alignment 6-1).
 *
 * The platform bills for the bytes a machine has ACTUALLY written to its
 * persistent filesystem (TRIM-friendly — deleting files lowers the bill), NOT
 * the provisioned volume size (docs.sprites.dev/concepts/lifecycle). To bill
 * measured usage the reconcile cron needs a persisted byte figure — but it must
 * NEVER wake a paused sprite to get one (that would recreate the Phase-3
 * keep-awake billing bug). So measurement is captured HERE, opportunistically,
 * only while a sprite is ALREADY awake for real work (terminal connect, agent
 * run, file browse), and throttled so a burst of real work costs at most one
 * cheap `df` per machine per window.
 *
 * Pure core (parse/convert/throttle) + a thin DI'd shell (`refreshStorageMeasurement`)
 * that runs one cheap `df` through an injected `MachineHandle.exec` and persists
 * via an injected writer — unit-tested against a fake handle with zero real
 * sprite calls.
 *
 * The HOT (NVMe cache) / COLD (durable object store) layers the platform keeps
 * under the filesystem are infra, not separately-billed tiers, so a single
 * used-bytes figure is the right quantity to meter; if the API later exposes a
 * per-tier split, that's a follow-up (see the leaf's Out-of-scope).
 */

import type { MachineHandle } from './machine-host';
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
export const STORAGE_MEASUREMENT_THROTTLE_MS = envInt('TERMINAL_STORAGE_MEASURE_THROTTLE_MS', 60 * 60 * 1000);

/**
 * The mount whose usage we bill — the persistent workspace root. Its used-bytes
 * ARE the persistent footprint that survives hibernation and accrues cost.
 */
export const STORAGE_MEASURE_PATH = SANDBOX_ROOT;

/** Wall-clock cap on the measurement exec — a `df` is instant, so a hang means the sprite is unhealthy; bail fast rather than block real work. */
const MEASURE_EXEC_TIMEOUT_MS = 5_000;

/**
 * Pure: parse `df -kP <path>` output → used bytes. POSIX `-P` guarantees a
 * single data line (no wrapping) whose fields are:
 *   Filesystem  1024-blocks  Used  Available  Capacity  Mounted-on
 * so the Used column (index 2), in 1024-byte blocks, × 1024 = bytes. Returns
 * null for empty / header-only / malformed output (caller then persists nothing).
 */
export function parseDfUsedBytes(stdout: string): number | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Need a header + at least one data row.
  if (lines.length < 2) return null;
  const dataLine = lines[lines.length - 1];
  const fields = dataLine.split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted-on → 6 fields.
  if (fields.length < 6) return null;
  const usedBlocks = Number(fields[2]);
  if (!Number.isInteger(usedBlocks) || usedBlocks < 0) return null;
  return usedBlocks * 1024;
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
  pageId: string;
  measuredBytes: number;
  measuredAt: Date;
}) => Promise<void>;

export interface RefreshStorageMeasurementInput {
  /** An ALREADY-AWAKE machine handle (real work is happening on it) — measurement never provisions/wakes. */
  handle: Pick<MachineHandle, 'exec'>;
  /** The terminal_sessions page this machine bills against. */
  pageId: string;
  /** Last persisted measurement time for this page (null = never measured). */
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
 * throttle window has elapsed. Fully non-fatal: any exec failure / non-zero
 * exit / unparseable output leaves the last good measurement untouched and
 * returns `{ measured: false }`. Runs at most one cheap `df` per call.
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
    run = await input.handle.exec({ cmd: 'df', args: ['-kP', path], timeoutMs: MEASURE_EXEC_TIMEOUT_MS });
  } catch {
    // Measurement is best-effort — a dead/unreachable sprite must never break
    // the real work that woke it.
    return { measured: false };
  }

  if (run.exitCode !== 0) return { measured: false };
  const bytes = parseDfUsedBytes(run.stdout);
  if (bytes === null) return { measured: false };

  await input.persist({ pageId: input.pageId, measuredBytes: bytes, measuredAt: input.now });
  return { measured: true, bytes };
}

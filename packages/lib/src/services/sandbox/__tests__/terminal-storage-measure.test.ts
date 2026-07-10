import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  parseDfUsedBytes,
  bytesToGB,
  shouldRefreshMeasurement,
  refreshStorageMeasurement,
  STORAGE_MEASUREMENT_THROTTLE_MS,
} from '../terminal-storage-measure';

describe('parseDfUsedBytes', () => {
  it('parses POSIX `df -kP` output → used bytes (used-blocks × 1024)', () => {
    const stdout = [
      'Filesystem     1024-blocks   Used Available Capacity Mounted on',
      '/dev/vda1        104857600 204800 104652800       1% /workspace',
    ].join('\n');
    assert({
      given: 'df -kP output showing 204800 used 1K-blocks',
      should: 'return 204800 * 1024 bytes',
      actual: parseDfUsedBytes(stdout),
      expected: 204800 * 1024,
    });
  });

  it('tolerates a trailing newline and extra whitespace', () => {
    const stdout = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 100 50 50 50% /\n\n';
    expect(parseDfUsedBytes(stdout)).toBe(50 * 1024);
  });

  it('returns null for empty / header-only / malformed output', () => {
    assert({ given: 'empty output', should: 'return null', actual: parseDfUsedBytes(''), expected: null });
    assert({
      given: 'header-only output',
      should: 'return null',
      actual: parseDfUsedBytes('Filesystem 1024-blocks Used Available Capacity Mounted on'),
      expected: null,
    });
    assert({
      given: 'a data line with a non-numeric Used field',
      should: 'return null',
      actual: parseDfUsedBytes('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 100 NaN 50 50% /'),
      expected: null,
    });
  });
});

describe('bytesToGB', () => {
  it('converts bytes to DECIMAL GB (÷1e9, matching the provider allocation + rate)', () => {
    assert({ given: '1e9 bytes', should: 'be 1 GB', actual: bytesToGB(1_000_000_000), expected: 1 });
    expect(bytesToGB(200_000_000)).toBeCloseTo(0.2, 10);
  });

  it('floors invalid / non-positive input at 0', () => {
    expect(bytesToGB(0)).toBe(0);
    expect(bytesToGB(-5)).toBe(0);
    expect(bytesToGB(Number.NaN)).toBe(0);
  });
});

describe('shouldRefreshMeasurement', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');
  const throttleMs = STORAGE_MEASUREMENT_THROTTLE_MS;

  it('measures when never measured before', () => {
    assert({
      given: 'a machine that has never been measured',
      should: 'measure',
      actual: shouldRefreshMeasurement({ lastMeasuredAt: null, now, throttleMs }),
      expected: true,
    });
  });

  it('measures when the last measurement is older than the throttle window', () => {
    expect(
      shouldRefreshMeasurement({ lastMeasuredAt: new Date(now.getTime() - throttleMs - 1), now, throttleMs }),
    ).toBe(true);
  });

  it('skips when a measurement was taken within the throttle window', () => {
    assert({
      given: 'a measurement taken well within the throttle window',
      should: 'skip (do not re-measure)',
      actual: shouldRefreshMeasurement({ lastMeasuredAt: new Date(now.getTime() - throttleMs + 1_000), now, throttleMs }),
      expected: false,
    });
  });
});

function fakeHandle(result: { exitCode: number; stdout: string; stderr?: string }) {
  const exec = vi.fn(async () => ({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' }));
  return { handle: { exec }, exec };
}

const DF_OK = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 104857600 204800 104652800 1% /workspace';

describe('refreshStorageMeasurement', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('measures via df, parses bytes, and persists {pageId, measuredBytes, measuredAt}', async () => {
    const { handle, exec } = fakeHandle({ exitCode: 0, stdout: DF_OK });
    const persisted: Array<{ pageId: string; measuredBytes: number; measuredAt: Date }> = [];

    const out = await refreshStorageMeasurement({
      handle,
      pageId: 'page-1',
      lastMeasuredAt: null,
      now,
      persist: async (p) => {
        persisted.push(p);
      },
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ measured: true, bytes: 204800 * 1024 });
    expect(persisted).toEqual([{ pageId: 'page-1', measuredBytes: 204800 * 1024, measuredAt: now }]);
  });

  it('is throttled: a recent measurement short-circuits WITHOUT any sprite exec', async () => {
    const { handle, exec } = fakeHandle({ exitCode: 0, stdout: DF_OK });
    const persist = vi.fn();

    const out = await refreshStorageMeasurement({
      handle,
      pageId: 'page-1',
      lastMeasuredAt: new Date(now.getTime() - 1_000), // 1s ago — within throttle
      now,
      persist,
    });

    assert({
      given: 'a measurement taken 1s ago (within the throttle window)',
      should: 'skip the sprite exec entirely',
      actual: exec.mock.calls.length,
      expected: 0,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(out).toEqual({ measured: false });
  });

  it('does not persist when df fails (non-zero exit) — leaves the last good measurement in place', async () => {
    const { handle } = fakeHandle({ exitCode: 1, stdout: '', stderr: 'df: /workspace: No such file' });
    const persist = vi.fn();

    const out = await refreshStorageMeasurement({ handle, pageId: 'p', lastMeasuredAt: null, now, persist });

    expect(persist).not.toHaveBeenCalled();
    expect(out).toEqual({ measured: false });
  });

  it('does not persist when df output is unparseable', async () => {
    const { handle } = fakeHandle({ exitCode: 0, stdout: 'garbage output' });
    const persist = vi.fn();

    const out = await refreshStorageMeasurement({ handle, pageId: 'p', lastMeasuredAt: null, now, persist });

    expect(persist).not.toHaveBeenCalled();
    expect(out).toEqual({ measured: false });
  });

  it('swallows an exec throw (non-fatal) and reports not-measured', async () => {
    const handle = {
      exec: vi.fn(async () => {
        throw new Error('sprite unreachable');
      }),
    };
    const persist = vi.fn();

    const out = await refreshStorageMeasurement({ handle, pageId: 'p', lastMeasuredAt: null, now, persist });

    expect(persist).not.toHaveBeenCalled();
    expect(out).toEqual({ measured: false });
  });
});

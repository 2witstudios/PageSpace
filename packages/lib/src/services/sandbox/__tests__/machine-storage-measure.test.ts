import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  parseDuBytes,
  bytesToGB,
  shouldRefreshMeasurement,
  refreshStorageMeasurement,
  STORAGE_MEASUREMENT_THROTTLE_MS,
} from '../machine-storage-measure';
import type { StorageSubject } from '../machine-storage-attribution';

describe('parseDuBytes', () => {
  it('parses `du -sbx` output → the leading byte total', () => {
    assert({
      given: 'du -sbx output "209715200\\t/workspace"',
      should: 'return 209715200 bytes',
      actual: parseDuBytes('209715200\t/workspace'),
      expected: 209_715_200,
    });
  });

  it('tolerates leading/trailing whitespace and a path containing spaces', () => {
    expect(parseDuBytes('  52428800   /workspace/my repo\n')).toBe(52_428_800);
  });

  it('reads only the FIRST line (du -s prints one summary line)', () => {
    // Defensive: even if a stray warning line follows, the total is line 1.
    expect(parseDuBytes('1024\t/workspace\ndu: cannot read: /workspace/x')).toBe(1024);
  });

  it('returns null for empty / non-numeric output', () => {
    assert({ given: 'empty output', should: 'return null', actual: parseDuBytes(''), expected: null });
    assert({ given: 'whitespace-only output', should: 'return null', actual: parseDuBytes('   \n  '), expected: null });
    assert({
      given: 'a leading non-numeric token',
      should: 'return null',
      actual: parseDuBytes('du: cannot access /workspace'),
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
  const exec = vi.fn(async (_args: { cmd: string; args?: string[] }) => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr ?? '',
  }));
  return { handle: { exec }, exec };
}

const DU_OK = '209715200\t/workspace';

describe('refreshStorageMeasurement', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('measures via `du -sbx`, parses bytes, and persists {subject, measuredBytes, measuredAt}', async () => {
    const { handle, exec } = fakeHandle({ exitCode: 0, stdout: DU_OK });
    const persisted: Array<{ subject: StorageSubject; measuredBytes: number; measuredAt: Date }> = [];

    const out = await refreshStorageMeasurement({
      handle,
      subject: { kind: 'machine', pageId: 'page-1' },
      lastMeasuredAt: null,
      now,
      persist: async (p) => {
        persisted.push(p);
      },
    });

    expect(exec).toHaveBeenCalledTimes(1);
    // Measures the workspace SUBTREE at ACTUAL disk usage (du -sxB1), not the
    // whole filesystem (df) and not apparent size (du -b).
    expect(exec.mock.calls[0][0]).toMatchObject({ cmd: 'du', args: ['-sxB1', '--', '/workspace'] });
    expect(out).toEqual({ measured: true, bytes: 209_715_200 });
    expect(persisted).toEqual([
      { subject: { kind: 'machine', pageId: 'page-1' }, measuredBytes: 209_715_200, measuredAt: now },
    ]);
  });

  it('persists a BRANCH Sprite measurement under its own branch subject, not a machine page', async () => {
    const { handle } = fakeHandle({ exitCode: 0, stdout: DU_OK });
    const persisted: Array<{ subject: StorageSubject; measuredBytes: number }> = [];

    await refreshStorageMeasurement({
      handle,
      subject: { kind: 'branch', machineBranchId: 'branch-1', machinePageId: 'machine-page-1' },
      lastMeasuredAt: null,
      now,
      persist: async (p) => {
        persisted.push({ subject: p.subject, measuredBytes: p.measuredBytes });
      },
    });

    assert({
      given: 'a measurement of a branch-terminal Sprite',
      should: 'persist under the branch subject (its own row), carrying the owning machine page for billing',
      actual: persisted,
      expected: [
        {
          subject: { kind: 'branch', machineBranchId: 'branch-1', machinePageId: 'machine-page-1' },
          measuredBytes: 209_715_200,
        },
      ],
    });
  });

  it('is throttled: a recent measurement short-circuits WITHOUT any sprite exec', async () => {
    const { handle, exec } = fakeHandle({ exitCode: 0, stdout: DU_OK });
    const persist = vi.fn();

    const out = await refreshStorageMeasurement({
      handle,
      subject: { kind: 'machine', pageId: 'page-1' },
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

  it('persists the readable-portion total when du exits non-zero (valid lower bound, not never-measured)', async () => {
    // du exits 1 on an unreadable subtree but still prints a valid cumulative
    // total of what it read — persist that conservative lower bound rather than
    // billing $0 forever (and re-walking the tree on every op).
    const { handle } = fakeHandle({ exitCode: 1, stdout: '4096\t/workspace', stderr: 'du: cannot read /workspace/x' });
    const persisted: Array<{ measuredBytes: number }> = [];

    const out = await refreshStorageMeasurement({
      handle,
      subject: { kind: 'machine', pageId: 'p' },
      lastMeasuredAt: null,
      now,
      persist: async (p) => {
        persisted.push({ measuredBytes: p.measuredBytes });
      },
    });

    expect(out).toEqual({ measured: true, bytes: 4096 });
    expect(persisted).toEqual([{ measuredBytes: 4096 }]);
  });

  it('does not persist when du output has no numeric total (true failure → retryable)', async () => {
    const { handle } = fakeHandle({ exitCode: 1, stdout: 'du: cannot access /workspace' });
    const persist = vi.fn();

    const out = await refreshStorageMeasurement({ handle, subject: { kind: 'machine', pageId: 'p' }, lastMeasuredAt: null, now, persist });

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

    const out = await refreshStorageMeasurement({ handle, subject: { kind: 'machine', pageId: 'p' }, lastMeasuredAt: null, now, persist });

    expect(persist).not.toHaveBeenCalled();
    expect(out).toEqual({ measured: false });
  });
});

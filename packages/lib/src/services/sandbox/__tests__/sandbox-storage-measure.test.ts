import { describe, it, expect } from 'vitest';
import {
  parseDuBytes,
  shouldRefreshMeasurement,
  refreshSessionStorageMeasurement,
  SESSION_STORAGE_MEASURE_PATH,
} from '../sandbox-storage-measure';

/**
 * Opportunistic storage measurement — the writer that gives
 * `agent_sessions.storageMeasuredBytes` a production source. Without it the
 * reconcile prices every session at the never-measured 0 floor while still
 * advancing its watermark, permanently discarding the interval.
 */

const NOW = new Date('2026-07-29T12:00:00.000Z');

function fakeHandle(run: { stdout: string; exitCode?: number } | Error) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    handle: {
      async exec(args: { cmd: string; args: string[] }) {
        calls.push({ cmd: args.cmd, args: args.args });
        if (run instanceof Error) throw run;
        return { exitCode: run.exitCode ?? 0, stdout: run.stdout, stderr: '' };
      },
    } as never,
  };
}

describe('parseDuBytes', () => {
  it('given a du summary line, should return the leading byte count', () => {
    expect(parseDuBytes('123456\t/workspace\n')).toBe(123456);
  });

  it('given a path containing spaces, should still read only the leading total', () => {
    expect(parseDuBytes('42\t/work space/dir\n')).toBe(42);
  });

  it('given empty or non-numeric output, should return null so nothing is persisted', () => {
    expect(parseDuBytes('')).toBeNull();
    expect(parseDuBytes('   \n  ')).toBeNull();
    expect(parseDuBytes('du: cannot read /x\n')).toBeNull();
  });

  it('given an unsafe integer, should return null rather than persist a bogus figure', () => {
    expect(parseDuBytes('999999999999999999999\t/workspace')).toBeNull();
  });
});

describe('shouldRefreshMeasurement', () => {
  it('given a never-measured session, should always measure', () => {
    expect(shouldRefreshMeasurement({ lastMeasuredAt: null, now: NOW, throttleMs: 1000 })).toBe(true);
  });

  it('given a measurement inside the throttle window, should skip', () => {
    const recent = new Date(NOW.getTime() - 500);
    expect(shouldRefreshMeasurement({ lastMeasuredAt: recent, now: NOW, throttleMs: 1000 })).toBe(false);
  });

  it('given a measurement exactly at the window edge, should measure', () => {
    const edge = new Date(NOW.getTime() - 1000);
    expect(shouldRefreshMeasurement({ lastMeasuredAt: edge, now: NOW, throttleMs: 1000 })).toBe(true);
  });
});

describe('refreshSessionStorageMeasurement', () => {
  it('given a never-measured session, should run du on the workspace and persist the bytes', async () => {
    const persisted: Array<{
      sessionId: string;
      spriteInstanceId: string | null;
      measuredBytes: number;
      measuredAt: Date;
    }> = [];
    const { handle, calls } = fakeHandle({ stdout: '2048\t/workspace\n' });

    const result = await refreshSessionStorageMeasurement({
      handle,
      sessionId: 'conv_1',
      spriteInstanceId: 'instance-A',
      lastMeasuredAt: null,
      now: NOW,
      persist: async (m) => { persisted.push(m); },
    });

    expect(result).toEqual({ measured: true, bytes: 2048 });
    // The instance travels WITH the bytes: the write is fire-and-forget, so the
    // writer needs to know which generation's disk this number describes before
    // it commits to a row that may have moved on.
    expect(persisted).toEqual([
      { sessionId: 'conv_1', spriteInstanceId: 'instance-A', measuredBytes: 2048, measuredAt: NOW },
    ]);
    // -B1 (allocated bytes, not apparent size) and -x (don't cross mounts) are
    // the whole reason this bills what was written rather than the allocation.
    expect(calls[0]).toEqual({ cmd: 'du', args: ['-sxB1', '--', SESSION_STORAGE_MEASURE_PATH] });
  });

  it('given a recent measurement, should skip the exec entirely (throttled)', async () => {
    const { handle, calls } = fakeHandle({ stdout: '999\t/workspace' });
    const result = await refreshSessionStorageMeasurement({
      handle,
      sessionId: 'conv_1',
      spriteInstanceId: 'instance-A',
      lastMeasuredAt: new Date(NOW.getTime() - 5),
      now: NOW,
      throttleMs: 60_000,
      persist: async () => { throw new Error('must not persist'); },
    });
    expect(result).toEqual({ measured: false });
    expect(calls).toHaveLength(0);
  });

  it('given the sandbox exec throws, should stay non-fatal and persist nothing', async () => {
    const { handle } = fakeHandle(new Error('sandbox unreachable'));
    const result = await refreshSessionStorageMeasurement({
      handle,
      sessionId: 'conv_1',
      spriteInstanceId: 'instance-A',
      lastMeasuredAt: null,
      now: NOW,
      persist: async () => { throw new Error('must not persist'); },
    });
    expect(result).toEqual({ measured: false });
  });

  it('given a non-zero du exit with a parseable total, should persist it as a conservative lower bound', async () => {
    const persisted: number[] = [];
    const { handle } = fakeHandle({ stdout: '4096\t/workspace\n', exitCode: 1 });
    const result = await refreshSessionStorageMeasurement({
      handle,
      sessionId: 'conv_1',
      spriteInstanceId: 'instance-A',
      lastMeasuredAt: null,
      now: NOW,
      persist: async (m) => { persisted.push(m.measuredBytes); },
    });
    expect(result).toEqual({ measured: true, bytes: 4096 });
    expect(persisted).toEqual([4096]);
  });

  it('given unparseable output, should report not-measured so the row stays retryable', async () => {
    const { handle } = fakeHandle({ stdout: 'du: permission denied\n', exitCode: 1 });
    const result = await refreshSessionStorageMeasurement({
      handle,
      sessionId: 'conv_1',
      spriteInstanceId: 'instance-A',
      lastMeasuredAt: null,
      now: NOW,
      persist: async () => { throw new Error('must not persist'); },
    });
    expect(result).toEqual({ measured: false });
  });
});

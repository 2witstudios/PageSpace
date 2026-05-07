import { describe, it, expect, vi } from 'vitest';
import { asyncPipe } from '../async-pipe';

describe('asyncPipe', () => {
  it('given an empty pipe and any input, should resolve to the input unchanged', async () => {
    const result = await asyncPipe()({ x: 1 });
    expect(result).toEqual({ x: 1 });
  });

  it('given a single sync step, should resolve to that step output', async () => {
    const double = (n: number) => n * 2;
    expect(await asyncPipe(double as never)(3)).toBe(6);
  });

  it('given a chain of sync + async steps, should thread values left to right', async () => {
    const add1 = (n: number) => n + 1;
    const asyncMul3 = async (n: number) => n * 3;
    const result = await asyncPipe(add1 as never, asyncMul3 as never)(2);
    expect(result).toBe(9);
  });

  it('given a step returning { ok: false }, should short-circuit and return that result unchanged', async () => {
    const failure = { ok: false as const, error: 'BOOM' };
    const fail = () => failure;
    const shouldNotRun = vi.fn();
    const result = await asyncPipe(fail as never, shouldNotRun as never)({});
    expect(result).toBe(failure);
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it('given a successful first step then a failing second step, should return the second failure', async () => {
    const ok1 = () => ({ ok: true as const, data: 'first' });
    const fail2 = () => ({ ok: false as const, error: 'SECOND_FAILED' });
    const shouldNotRun = vi.fn();
    const result = await asyncPipe(ok1 as never, fail2 as never, shouldNotRun as never)({});
    expect(result).toEqual({ ok: false, error: 'SECOND_FAILED' });
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it('given an initial input that is already a failure, should short-circuit before the first step', async () => {
    const failure = { ok: false as const, error: 'PRE_PIPE' };
    const shouldNotRun = vi.fn();
    const result = await asyncPipe(shouldNotRun as never)(failure);
    expect(result).toBe(failure);
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it('given { ok: true, data } passed through, should not be mistaken for a failure', async () => {
    const success = { ok: true as const, data: 42 };
    const next = (v: typeof success) => ({ ok: true as const, data: v.data + 1 });
    const result = await asyncPipe(next as never)(success);
    expect(result).toEqual({ ok: true, data: 43 });
  });

  it('given a step that throws, should reject (we do not swallow exceptions inside the pipe)', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    await expect(asyncPipe(boom as never)({})).rejects.toThrow('boom');
  });
});

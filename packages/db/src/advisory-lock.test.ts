import { describe, it, expect, vi } from 'vitest';
import { withAdvisoryLock, type AdvisoryLockPool } from './advisory-lock';

function makeClient(overrides: Partial<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = {}) {
  return {
    query: vi.fn(),
    release: vi.fn(),
    ...overrides,
  };
}

describe('withAdvisoryLock', () => {
  it('given the lock is free, should acquire it, run fn, and release cleanly', async () => {
    const client = makeClient({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // try-lock
        .mockResolvedValueOnce({ rows: [] }), // unlock
    });
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => client) };
    const fn = vi.fn(async () => 'work-result');

    const result = await withAdvisoryLock(pool, 'my-lock', fn);

    expect(result).toEqual({ outcome: 'acquired', result: 'work-result' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(client.query.mock.calls[0][1]).toEqual(['my-lock']);
    expect(client.query.mock.calls[1][0]).toContain('pg_advisory_unlock');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });

  it('given the lock is already held, should no-op WITHOUT running fn and release without destroying', async () => {
    const client = makeClient({ query: vi.fn().mockResolvedValueOnce({ rows: [{ acquired: false }] }) });
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => client) };
    const fn = vi.fn(async () => 'unreachable');

    const result = await withAdvisoryLock(pool, 'my-lock', fn);

    expect(result).toEqual({ outcome: 'lock_busy' });
    expect(fn).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });

  it('given the unlock query fails after acquiring, should destroy the connection instead of releasing it alive', async () => {
    const client = makeClient({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce(new Error('unlock failed')),
    });
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => client) };

    const result = await withAdvisoryLock(pool, 'my-lock', async () => 'ok');

    expect(result).toEqual({ outcome: 'acquired', result: 'ok' });
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  // pg's release(err) only destroys the connection when handed an actual Error — a raw driver
  // rejection value (drivers CAN reject with strings/objects) passed through unwrapped would be
  // truthy enough to look intentional but is not guaranteed to trip pg's destroy path. The
  // helper must wrap it so the destroy-instead-of-pool decision (and the operator-visible log)
  // hold regardless of what the driver rejected with.
  it('given the unlock query rejects with a non-Error value, should wrap it in an Error (preserving the original text) and still destroy the connection', async () => {
    const client = makeClient({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce('unlock rejected as a plain string'),
    });
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => client) };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await withAdvisoryLock(pool, 'my-lock', async () => 'ok');

    expect(result).toEqual({ outcome: 'acquired', result: 'ok' });
    expect(client.release).toHaveBeenCalledTimes(1);
    const releasedWith = client.release.mock.calls[0][0];
    expect(releasedWith).toBeInstanceOf(Error);
    expect((releasedWith as Error).message).toContain('unlock rejected as a plain string');
    // The recurring-failure signal must stay operator-visible even for non-Error rejections.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Advisory unlock failed'),
      'unlock rejected as a plain string',
    );
    errorSpy.mockRestore();
  });

  // Leaf 5.6/5.7 (triaged D fix, fmfmzw4g4gh6u6q9cjt7ylne): the lock connection's own failure
  // must be a STRUCTURALLY distinct, resolved outcome — never a thrown/rejected promise — so a
  // caller can tell "the lock machinery is broken" apart from "fn threw" without guessing. Before
  // this fix both surfaced as the same unwrapped, untagged rejected promise.
  it('given the try-lock query itself throws, should destroy the connection and resolve connection_error (never resolve acquired/busy, never reject)', async () => {
    const client = makeClient({ query: vi.fn().mockRejectedValueOnce(new Error('connection reset')) });
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => client) };
    const fn = vi.fn(async () => 'unreachable');

    const result = await withAdvisoryLock(pool, 'my-lock', fn);

    expect(result.outcome).toBe('connection_error');
    expect(result).toMatchObject({ outcome: 'connection_error', error: expect.any(Error) });
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('given pool.connect() itself throws, should resolve connection_error (never reject, never touch a client)', async () => {
    const connectError = new Error('pool exhausted');
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => { throw connectError; }) };
    const fn = vi.fn(async () => 'unreachable');

    const result = await withAdvisoryLock(pool, 'my-lock', fn);

    expect(result).toEqual({ outcome: 'connection_error', error: connectError });
    expect(fn).not.toHaveBeenCalled();
  });

  it('given fn itself throws after acquiring, should still unlock cleanly (fn error does not poison the lock connection) and rethrow', async () => {
    const client = makeClient({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [] }),
    });
    const pool: AdvisoryLockPool = { connect: vi.fn(async () => client) };
    const fn = vi.fn(async () => {
      throw new Error('work failed');
    });

    await expect(withAdvisoryLock(pool, 'my-lock', fn)).rejects.toThrow('work failed');

    // fn's failure is unrelated to the lock connection's own protocol state —
    // the unlock still runs and the connection is released alive.
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });
});

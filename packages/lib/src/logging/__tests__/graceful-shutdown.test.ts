import { describe, it, expect, vi } from 'vitest';
import { createShutdownHandler } from '../graceful-shutdown';

// #890 Phase 3 FIX: logger.ts's old SIGTERM handler fire-and-forgot flush()
// then called process.exit(0) synchronously — the CH insert buffers (fed by
// writeLogsToDatabase during that flush) were killed before any flush, losing
// up to 500 rows/table on EVERY deploy. The handler must sequence:
// flush logs → drain analytics → exit.

describe('createShutdownHandler — flush → drain → exit ordering', () => {
  it('given a shutdown, should flush the log buffer BEFORE draining analytics (flush feeds rows into the CH buffers), then exit 0', async () => {
    const order: string[] = [];
    const handler = createShutdownHandler({
      flushLogs: vi.fn(async () => {
        order.push('flush');
      }),
      drainAnalytics: vi.fn(async () => {
        order.push('drain');
      }),
      exit: vi.fn((code: number) => {
        order.push(`exit:${code}`);
      }),
    });

    await handler();

    expect(order).toEqual(['flush', 'drain', 'exit:0']);
  });

  it('given the log flush fails, should STILL drain analytics and exit', async () => {
    const drainAnalytics = vi.fn(async () => {});
    const exit = vi.fn();
    const handler = createShutdownHandler({
      flushLogs: vi.fn(async () => {
        throw new Error('db down');
      }),
      drainAnalytics,
      exit,
    });

    await handler();

    expect(drainAnalytics).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('given the analytics drain fails, should still exit (shutdown must never hang)', async () => {
    const exit = vi.fn();
    const handler = createShutdownHandler({
      flushLogs: vi.fn(async () => {}),
      drainAnalytics: vi.fn(async () => {
        throw new Error('CH unreachable');
      }),
      exit,
    });

    await handler();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('given concurrent invocations (SIGINT then SIGTERM), should run the sequence once', async () => {
    const flushLogs = vi.fn(async () => {});
    const exit = vi.fn();
    const handler = createShutdownHandler({
      flushLogs,
      drainAnalytics: vi.fn(async () => {}),
      exit,
    });

    await Promise.all([handler(), handler()]);

    expect(flushLogs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

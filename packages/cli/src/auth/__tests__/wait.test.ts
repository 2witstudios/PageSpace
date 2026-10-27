import { describe, expect, it, vi } from 'vitest';
import { unrefWaitMs, waitMs } from '../wait.js';

function spawnedTimer(spy: { mock: { results: { value: unknown }[] } }): NodeJS.Timeout {
  const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
  expect(timer).toBeDefined();
  return timer;
}

describe('waitMs', () => {
  it('schedules a REF\'D timer — a pending poll delay must keep the process alive', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      void waitMs(60_000);
      const timer = spawnedTimer(spy);
      expect(timer.hasRef()).toBe(true);
      clearTimeout(timer);
    } finally {
      spy.mockRestore();
    }
  });

  it('resolves after the delay', async () => {
    await expect(waitMs(1)).resolves.toBeUndefined();
  });
});

describe('unrefWaitMs', () => {
  it("schedules an UNREF'D timer — the losing timeout arm of the loopback race must never pin the event loop", () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      void unrefWaitMs(60_000);
      const timer = spawnedTimer(spy);
      expect(timer.hasRef()).toBe(false);
      clearTimeout(timer);
    } finally {
      spy.mockRestore();
    }
  });

  it('still resolves after the delay while the process is otherwise alive', async () => {
    await expect(unrefWaitMs(1)).resolves.toBeUndefined();
  });
});

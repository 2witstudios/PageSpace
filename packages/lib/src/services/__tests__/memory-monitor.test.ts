import { describe, it, expect } from 'vitest';

// memory-monitor is now a stub — all functions return safe defaults
describe('memory-monitor', () => {
  it('getMemoryStatus returns canAcceptUpload true', async () => {
    const { getMemoryStatus } = await import('../memory-monitor');
    const status = await getMemoryStatus();
    expect(status.canAcceptUpload).toBe(true);
    expect(status.warningLevel).toBe('normal');
  });

  it('getProcessMemory returns numeric fields', async () => {
    const { getProcessMemory } = await import('../memory-monitor');
    const mem = getProcessMemory();
    expect(typeof mem.rss).toBe('number');
    expect(typeof mem.heapTotal).toBe('number');
  });

  it('hasEnoughMemoryForUpload always returns true', async () => {
    const { hasEnoughMemoryForUpload } = await import('../memory-monitor');
    expect(await hasEnoughMemoryForUpload(1024)).toBe(true);
    expect(await hasEnoughMemoryForUpload(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('checkMemoryMiddleware always allows', async () => {
    const { checkMemoryMiddleware } = await import('../memory-monitor');
    const result = await checkMemoryMiddleware();
    expect(result.allowed).toBe(true);
  });

  it('formatMemory formats MB and GB', async () => {
    const { formatMemory } = await import('../memory-monitor');
    expect(formatMemory(512)).toBe('512MB');
    expect(formatMemory(2048)).toBe('2.00GB');
  });

  it('emergencyMemoryCleanup does not throw', async () => {
    const { emergencyMemoryCleanup } = await import('../memory-monitor');
    expect(() => emergencyMemoryCleanup()).not.toThrow();
  });

  it('setupMemoryProtection returns a timer', async () => {
    const { setupMemoryProtection } = await import('../memory-monitor');
    const timer = setupMemoryProtection(60000);
    expect(timer).toBeDefined();
    clearInterval(timer as unknown as NodeJS.Timeout);
  });
});

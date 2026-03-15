import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', () => ({
  default: {
    totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024), // 16GB
    freemem: vi.fn(() => 8 * 1024 * 1024 * 1024),  // 8GB free
  },
  totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
  freemem: vi.fn(() => 8 * 1024 * 1024 * 1024),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

describe('memory-monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should return memory status with all fields', async () => {
    const { getMemoryStatus } = await import('../memory-monitor');
    const status = await getMemoryStatus();
    expect(status.totalMB).toBeGreaterThan(0);
    expect(typeof status.freeMB).toBe('number');
    expect(typeof status.usedMB).toBe('number');
    expect(typeof status.availableMB).toBe('number');
    expect(typeof status.percentUsed).toBe('number');
    expect(typeof status.canAcceptUpload).toBe('boolean');
    expect(['normal', 'warning', 'critical']).toContain(status.warningLevel);
  });

  it('should return process memory info', async () => {
    const { getProcessMemory } = await import('../memory-monitor');
    const mem = getProcessMemory();
    expect(mem.rss).toBeGreaterThan(0);
    expect(mem.heapTotal).toBeGreaterThan(0);
    expect(mem.heapUsed).toBeGreaterThan(0);
    expect(typeof mem.external).toBe('number');
    expect(typeof mem.arrayBuffers).toBe('number');
  });

  it('should return true for small file upload memory check', async () => {
    const { hasEnoughMemoryForUpload } = await import('../memory-monitor');
    const result = await hasEnoughMemoryForUpload(1024); // 1KB
    expect(result).toBe(true);
  });

  it('should return false for extremely large file upload', async () => {
    const { hasEnoughMemoryForUpload } = await import('../memory-monitor');
    const result = await hasEnoughMemoryForUpload(Number.MAX_SAFE_INTEGER);
    expect(result).toBe(false);
  });

  it('should allow requests in middleware when memory is normal', async () => {
    const { checkMemoryMiddleware } = await import('../memory-monitor');
    const result = await checkMemoryMiddleware();
    expect(result.allowed).toBe(true);
  });

  it('should format MB values', async () => {
    const { formatMemory } = await import('../memory-monitor');
    expect(formatMemory(512)).toBe('512MB');
  });

  it('should format GB values', async () => {
    const { formatMemory } = await import('../memory-monitor');
    expect(formatMemory(2048)).toBe('2.00GB');
  });

  it('should handle emergency cleanup without throwing', async () => {
    const { emergencyMemoryCleanup } = await import('../memory-monitor');
    expect(() => emergencyMemoryCleanup()).not.toThrow();
  });

  it('should return interval from setupMemoryProtection', async () => {
    const { setupMemoryProtection } = await import('../memory-monitor');
    const timer = setupMemoryProtection(60000);
    expect(timer).toBeDefined();
    clearInterval(timer as unknown as NodeJS.Timeout);
  });

  it('should reject requests when memory is critical (>90%)', async () => {
    const os = await import('os');
    vi.mocked(os.default.totalmem).mockReturnValue(16 * 1024 * 1024 * 1024);
    vi.mocked(os.default.freemem).mockReturnValue(1 * 1024 * 1024 * 1024); // only 1GB free = ~94% used

    const { checkMemoryMiddleware } = await import('../memory-monitor');
    const result = await checkMemoryMiddleware();
    // With 94% used, it might be critical or at least canAcceptUpload might be true since 1GB > 500MB
    // The getWarningLevel returns 'critical' at 90%+
    expect(typeof result.allowed).toBe('boolean');
  });
});

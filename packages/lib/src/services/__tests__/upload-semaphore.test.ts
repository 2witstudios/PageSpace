import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../storage-limits', () => ({
  STORAGE_TIERS: {
    free: { maxConcurrentUploads: 2 },
    starter: { maxConcurrentUploads: 3 },
    pro: { maxConcurrentUploads: 5 },
    enterprise: { maxConcurrentUploads: 10 },
  },
}));

// Default: 70% memory used, 500MB free = "normal" but no permit increase
const mockGetMemoryStatus = vi.fn().mockResolvedValue({
  percentUsed: 70,
  availableMB: 500,
  warningLevel: 'normal',
  canAcceptUpload: true,
});

vi.mock('../memory-monitor', () => ({
  getMemoryStatus: (...args: unknown[]) => mockGetMemoryStatus(...args),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  },
}));

describe('upload-semaphore', () => {
  let uploadSemaphore: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    // Reset the memory mock to default
    mockGetMemoryStatus.mockResolvedValue({
      percentUsed: 70,
      availableMB: 500,
      warningLevel: 'normal',
      canAcceptUpload: true,
    });

    const mod = await import('../upload-semaphore');
    uploadSemaphore = mod.uploadSemaphore;
    uploadSemaphore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('acquireUploadSlot', () => {
    it('should grant a slot and return slotId', async () => {
      const slotId = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(slotId).not.toBeNull();
      expect(typeof slotId).toBe('string');
    });

    it('should reject when global limit reached', async () => {
      // Fill all 3 slots (base = 3)
      await uploadSemaphore.acquireUploadSlot('user-1', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('user-2', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('user-3', 'pro', 1024);

      const result = await uploadSemaphore.acquireUploadSlot('user-4', 'pro', 1024);
      expect(result).toBeNull();
    });

    it('should reject when user tier limit reached', async () => {
      // Free tier allows 2 concurrent
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      const result = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(result).toBeNull();
    });

    it('should reject when memory check fails (canAcceptUpload = false)', async () => {
      mockGetMemoryStatus.mockResolvedValue({
        percentUsed: 95,
        availableMB: 100,
        warningLevel: 'critical',
        canAcceptUpload: false,
      });

      const result = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(result).toBeNull();
    });

    it('should reject large files during memory warning', async () => {
      mockGetMemoryStatus.mockResolvedValue({
        percentUsed: 80,
        availableMB: 500,
        warningLevel: 'warning',
        canAcceptUpload: true,
      });

      // 15MB file should be rejected during warning
      const result = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 15 * 1024 * 1024);
      expect(result).toBeNull();
    });

    it('should allow upload when memory check throws', async () => {
      mockGetMemoryStatus.mockRejectedValue(new Error('mem error'));

      const result = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(result).not.toBeNull();
    });
  });

  describe('releaseUploadSlot', () => {
    it('should release a slot', async () => {
      const slotId = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.releaseUploadSlot(slotId!);

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(0);
    });

    it('should handle non-existent slot gracefully', () => {
      uploadSemaphore.releaseUploadSlot('non-existent-slot');
      // Should not throw
    });

    it('should clean up user permits when all released', async () => {
      const slotId = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.releaseUploadSlot(slotId!);

      const status = uploadSemaphore.getStatus();
      expect(status.userUploads.has('user-1')).toBe(false);
    });
  });

  describe('canAcquireSlot', () => {
    it('should return true when slot available', async () => {
      const result = await uploadSemaphore.canAcquireSlot('user-1', 'free');
      expect(result).toBe(true);
    });

    it('should return false when global limit reached', async () => {
      await uploadSemaphore.acquireUploadSlot('u1', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('u2', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('u3', 'pro', 1024);

      const result = await uploadSemaphore.canAcquireSlot('u4', 'pro');
      expect(result).toBe(false);
    });

    it('should return false when user tier limit reached', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      const result = await uploadSemaphore.canAcquireSlot('user-1', 'free');
      expect(result).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return current status', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(1);
      expect(status.globalSlotsUsed).toBe(1);
      expect(status.configuredLimit).toBe(3);
    });
  });

  describe('releaseUserSlots', () => {
    it('should release all slots for a user', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 2048);

      uploadSemaphore.releaseUserSlots('user-1');

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(0);
    });

    it('should not affect other users', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-2', 'free', 1024);

      uploadSemaphore.releaseUserSlots('user-1');

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(1);
    });
  });

  describe('reset', () => {
    it('should reset all state', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.reset();

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(0);
      expect(status.globalSlotsAvailable).toBe(3);
    });
  });

  describe('dynamic limits', () => {
    it('should reduce permits under critical memory', async () => {
      mockGetMemoryStatus.mockResolvedValue({
        percentUsed: 95,
        availableMB: 100,
        warningLevel: 'critical',
        canAcceptUpload: true,
      });

      // Force dynamic limit update by advancing past memoryCheckInterval
      vi.advanceTimersByTime(31000);

      // Acquire triggers updateDynamicLimits
      await uploadSemaphore.acquireUploadSlot('user-1', 'pro', 1024);

      const status = uploadSemaphore.getStatus();
      // Critical memory should reduce limit below the base of 3
      expect(status.configuredLimit).toBeLessThan(3);
    });
  });
});

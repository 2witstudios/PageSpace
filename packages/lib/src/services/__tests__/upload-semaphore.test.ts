import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../storage-limits', () => ({
  STORAGE_TIERS: {
    free: { maxConcurrentUploads: 2 },
    starter: { maxConcurrentUploads: 3 },
    pro: { maxConcurrentUploads: 5 },
    enterprise: { maxConcurrentUploads: 10 },
  },
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  },
}));

describe('upload-semaphore', () => {
  let uploadSemaphore: Awaited<typeof import('../upload-semaphore')>['uploadSemaphore'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    // UPLOAD_MAX_PERMITS controls global limit; default in tests is env var or 20
    process.env.UPLOAD_MAX_PERMITS = '3';

    const mod = await import('../upload-semaphore');
    uploadSemaphore = mod.uploadSemaphore;
    uploadSemaphore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.UPLOAD_MAX_PERMITS;
  });

  describe('acquireUploadSlot', () => {
    it('grants a slot and returns slotId', async () => {
      const slotId = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(slotId).not.toBeNull();
      expect(typeof slotId).toBe('string');
    });

    it('rejects when global limit reached', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('user-2', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('user-3', 'pro', 1024);

      const result = await uploadSemaphore.acquireUploadSlot('user-4', 'pro', 1024);
      expect(result).toBeNull();
    });

    it('rejects when user tier limit reached', async () => {
      // free tier: maxConcurrentUploads = 2
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      const result = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(result).toBeNull();
    });

    it('allows different users up to global limit', async () => {
      const s1 = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      const s2 = await uploadSemaphore.acquireUploadSlot('user-2', 'free', 1024);
      const s3 = await uploadSemaphore.acquireUploadSlot('user-3', 'free', 1024);

      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s3).not.toBeNull();
    });
  });

  describe('releaseUploadSlot', () => {
    it('releases a slot', async () => {
      const slotId = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.releaseUploadSlot(slotId!);

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(0);
    });

    it('handles non-existent slot gracefully', () => {
      expect(() => uploadSemaphore.releaseUploadSlot('non-existent-slot')).not.toThrow();
    });

    it('cleans up user permits when all released', async () => {
      const slotId = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.releaseUploadSlot(slotId!);

      const status = uploadSemaphore.getStatus();
      expect(status.userUploads.has('user-1')).toBe(false);
    });

    it('frees up a global slot for the next requester', async () => {
      const s1 = await uploadSemaphore.acquireUploadSlot('user-1', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('user-2', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('user-3', 'pro', 1024);

      uploadSemaphore.releaseUploadSlot(s1!);

      const s4 = await uploadSemaphore.acquireUploadSlot('user-4', 'pro', 1024);
      expect(s4).not.toBeNull();
    });
  });

  describe('canAcquireSlot', () => {
    it('returns true when slot available', async () => {
      expect(await uploadSemaphore.canAcquireSlot('user-1', 'free')).toBe(true);
    });

    it('returns false when global limit reached', async () => {
      await uploadSemaphore.acquireUploadSlot('u1', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('u2', 'pro', 1024);
      await uploadSemaphore.acquireUploadSlot('u3', 'pro', 1024);

      expect(await uploadSemaphore.canAcquireSlot('u4', 'pro')).toBe(false);
    });

    it('returns false when user tier limit reached', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      expect(await uploadSemaphore.canAcquireSlot('user-1', 'free')).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns current status', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(1);
      expect(status.globalSlotsUsed).toBe(1);
      expect(status.configuredLimit).toBe(3);
    });
  });

  describe('releaseUserSlots', () => {
    it('releases all slots for a user', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 2048);

      uploadSemaphore.releaseUserSlots('user-1');

      expect(uploadSemaphore.getStatus().activeSlots).toBe(0);
    });

    it('does not affect other users', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      await uploadSemaphore.acquireUploadSlot('user-2', 'free', 1024);

      uploadSemaphore.releaseUserSlots('user-1');

      expect(uploadSemaphore.getStatus().activeSlots).toBe(1);
    });
  });

  describe('reset', () => {
    it('resets all state', async () => {
      await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.reset();

      const status = uploadSemaphore.getStatus();
      expect(status.activeSlots).toBe(0);
      expect(status.globalSlotsAvailable).toBe(3);
    });
  });
});

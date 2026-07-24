import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReleasePendingUpload = vi.fn();

vi.mock('../storage-limits', () => ({
  STORAGE_TIERS: {
    free: { maxConcurrentUploads: 2 },
    starter: { maxConcurrentUploads: 3 },
    pro: { maxConcurrentUploads: 5 },
    enterprise: { maxConcurrentUploads: 10 },
  },
}));

vi.mock('../pending-uploads', () => ({
  releasePendingUpload: (...args: unknown[]) => mockReleasePendingUpload(...args),
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
    mockReleasePendingUpload.mockReset();
    mockReleasePendingUpload.mockResolvedValue(undefined);

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

  describe('verifySlotOwner', () => {
    it('returns true for the user that reserved the slot', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(uploadSemaphore.verifySlotOwner(slot!, 'user-1')).toBe(true);
    });

    it('returns false for a different user', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(uploadSemaphore.verifySlotOwner(slot!, 'user-2')).toBe(false);
    });

    it('returns false for an unknown slot', () => {
      expect(uploadSemaphore.verifySlotOwner('does-not-exist', 'user-1')).toBe(false);
    });

    it('rejects and reclaims a slot older than the timeout', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute slot timeout
      expect(uploadSemaphore.verifySlotOwner(slot!, 'user-1')).toBe(false);
      // Reclamation is durable/async (DB decrement awaited before in-memory removal).
      await vi.advanceTimersByTimeAsync(0);
      expect(uploadSemaphore.getStatus().activeSlots).toBe(0);
    });
  });

  describe('getSlotMetadata', () => {
    const META = { contentHash: 'a'.repeat(64), driveId: 'drive-1', fileSize: 1024, mimeType: 'image/jpeg' };

    it('returns the metadata captured at acquire time for the owning user', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024, META);
      expect(uploadSemaphore.getSlotMetadata(slot!, 'user-1')).toEqual(META);
    });

    it('returns null for a different user', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024, META);
      expect(uploadSemaphore.getSlotMetadata(slot!, 'user-2')).toBeNull();
    });

    it('returns null for an expired slot', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024, META);
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(uploadSemaphore.getSlotMetadata(slot!, 'user-1')).toBeNull();
    });

    it('returns null when a slot was acquired without metadata', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      expect(uploadSemaphore.getSlotMetadata(slot!, 'user-1')).toBeNull();
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

  describe('L8/#2154 — stale-slot sweep releases the pending_uploads row', () => {
    it('deletes the pending row for a slot abandoned past the timeout (cron sweep)', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);

      // Past the 10-minute slot timeout; advancing 11 minutes also fires the
      // once-a-minute cleanup interval. Async so the durable release + in-memory
      // removal microtasks flush.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      expect(mockReleasePendingUpload).toHaveBeenCalledWith(slot);
      expect(uploadSemaphore.getStatus().activeSlots).toBe(0);
    });

    it('deletes the pending row when an expired slot is reclaimed via verifySlotOwner', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      // Do not cross a full cleanup tick; reclaim happens through verifySlotOwner.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      expect(uploadSemaphore.verifySlotOwner(slot!, 'user-1')).toBe(false);
      // The async release is invoked synchronously up to its await.
      expect(mockReleasePendingUpload).toHaveBeenCalledWith(slot);
    });

    it('does NOT delete the pending row on a normal release (the route does that)', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      uploadSemaphore.releaseUploadSlot(slot!);

      expect(mockReleasePendingUpload).not.toHaveBeenCalled();
    });

    it('skips the redundant delete for a claimed slot (the completing route releases it)', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024, {
        contentHash: 'a'.repeat(64), driveId: 'd', fileSize: 1024, mimeType: 'image/png',
      });
      // A route claims the slot for completion (it will do its own release).
      uploadSemaphore.getSlotMetadata(slot!, 'user-1');

      // The slot then times out while the route is still in flight.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      // Sweep reclaimed the in-memory permit but left the row to the route.
      expect(uploadSemaphore.getStatus().activeSlots).toBe(0);
      expect(mockReleasePendingUpload).not.toHaveBeenCalled();
    });

    it('keeps the slot for retry when the row delete fails (durable)', async () => {
      const slot = await uploadSemaphore.acquireUploadSlot('user-1', 'free', 1024);
      mockReleasePendingUpload.mockRejectedValueOnce(new Error('db down'));

      // First sweep: release fails → slot retained.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(uploadSemaphore.getStatus().activeSlots).toBe(1);

      // Next sweep (60s later): release succeeds → slot reclaimed.
      mockReleasePendingUpload.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(mockReleasePendingUpload).toHaveBeenCalledWith(slot);
      expect(uploadSemaphore.getStatus().activeSlots).toBe(0);
    });
  });
});

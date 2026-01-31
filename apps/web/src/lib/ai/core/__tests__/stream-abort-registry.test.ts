import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock cuid2 to return predictable IDs
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-stream-id'),
}));

// Tests use dynamic imports to get fresh module state - no static imports needed

describe('stream-abort-registry', () => {
  // Reset the module between tests to clear the registry
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createStreamAbortController', () => {
    it('creates controller with auto-generated streamId', async () => {
      // Re-import to get fresh module state
      const registry = await import('../stream-abort-registry');

      const result = registry.createStreamAbortController({ userId: 'user-123' });

      expect(result.streamId).toBe('mock-stream-id');
      expect(result.signal).toBeInstanceOf(AbortSignal);
      expect(result.controller).toBeInstanceOf(AbortController);
    });

    it('creates controller with custom streamId', async () => {
      const registry = await import('../stream-abort-registry');

      const result = registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'custom-stream-id',
      });

      expect(result.streamId).toBe('custom-stream-id');
    });

    it('stores userId with the stream entry', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'test-stream',
      });

      expect(registry.isStreamActive({ streamId: 'test-stream' })).toBe(true);
    });

    it('creates unique controllers for concurrent streams', async () => {
      const registry = await import('../stream-abort-registry');

      const result1 = registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'stream-1',
      });
      const result2 = registry.createStreamAbortController({
        userId: 'user-456',
        streamId: 'stream-2',
      });

      expect(result1.controller).not.toBe(result2.controller);
      expect(result1.signal).not.toBe(result2.signal);
      expect(registry.getActiveStreamCount()).toBe(2);
    });
  });

  describe('abortStream', () => {
    it('aborts stream for matching userId', async () => {
      const registry = await import('../stream-abort-registry');

      const { controller } = registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'test-stream',
      });

      const result = registry.abortStream({
        streamId: 'test-stream',
        userId: 'user-123',
      });

      expect(result.aborted).toBe(true);
      expect(result.reason).toBe('Stream aborted by user request');
      expect(controller.signal.aborted).toBe(true);
    });

    it('fails for different userId (IDOR protection)', async () => {
      const registry = await import('../stream-abort-registry');

      const { controller } = registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'test-stream',
      });

      const result = registry.abortStream({
        streamId: 'test-stream',
        userId: 'attacker-456', // Different user trying to abort
      });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Unauthorized to abort this stream');
      expect(controller.signal.aborted).toBe(false);
      // Stream should still be active
      expect(registry.isStreamActive({ streamId: 'test-stream' })).toBe(true);
    });

    it('fails for non-existent stream', async () => {
      const registry = await import('../stream-abort-registry');

      const result = registry.abortStream({
        streamId: 'non-existent-stream',
        userId: 'user-123',
      });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Stream not found or already completed');
    });

    it('removes stream from registry after abort', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'test-stream',
      });

      registry.abortStream({
        streamId: 'test-stream',
        userId: 'user-123',
      });

      expect(registry.isStreamActive({ streamId: 'test-stream' })).toBe(false);
    });
  });

  describe('removeStream', () => {
    it('removes stream from registry', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'test-stream',
      });

      expect(registry.isStreamActive({ streamId: 'test-stream' })).toBe(true);

      registry.removeStream({ streamId: 'test-stream' });

      expect(registry.isStreamActive({ streamId: 'test-stream' })).toBe(false);
    });

    it('handles removing non-existent stream gracefully', async () => {
      const registry = await import('../stream-abort-registry');

      // Should not throw
      expect(() => {
        registry.removeStream({ streamId: 'non-existent' });
      }).not.toThrow();
    });
  });

  describe('isStreamActive', () => {
    it('returns true for active stream', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'test-stream',
      });

      expect(registry.isStreamActive({ streamId: 'test-stream' })).toBe(true);
    });

    it('returns false for non-existent stream', async () => {
      const registry = await import('../stream-abort-registry');

      expect(registry.isStreamActive({ streamId: 'non-existent' })).toBe(false);
    });
  });

  describe('getActiveStreamCount', () => {
    it('returns correct count of active streams', async () => {
      const registry = await import('../stream-abort-registry');

      expect(registry.getActiveStreamCount()).toBe(0);

      registry.createStreamAbortController({
        userId: 'user-1',
        streamId: 'stream-1',
      });
      expect(registry.getActiveStreamCount()).toBe(1);

      registry.createStreamAbortController({
        userId: 'user-2',
        streamId: 'stream-2',
      });
      expect(registry.getActiveStreamCount()).toBe(2);

      registry.removeStream({ streamId: 'stream-1' });
      expect(registry.getActiveStreamCount()).toBe(1);
    });
  });

  describe('concurrent streams isolation', () => {
    it('streams from different users do not interfere', async () => {
      const registry = await import('../stream-abort-registry');

      const { controller: controller1 } = registry.createStreamAbortController({
        userId: 'user-1',
        streamId: 'stream-1',
      });

      const { controller: controller2 } = registry.createStreamAbortController({
        userId: 'user-2',
        streamId: 'stream-2',
      });

      // Abort stream 1
      registry.abortStream({ streamId: 'stream-1', userId: 'user-1' });

      // Stream 1 should be aborted
      expect(controller1.signal.aborted).toBe(true);
      expect(registry.isStreamActive({ streamId: 'stream-1' })).toBe(false);

      // Stream 2 should still be active
      expect(controller2.signal.aborted).toBe(false);
      expect(registry.isStreamActive({ streamId: 'stream-2' })).toBe(true);
    });
  });
});

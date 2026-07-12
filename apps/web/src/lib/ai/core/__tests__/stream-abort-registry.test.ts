import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { assert } from './riteway';

// Mock cuid2 to return predictable IDs
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-stream-id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
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

  describe('abortStreamByMessageId', () => {
    it('aborts stream by messageId when registered', async () => {
      const registry = await import('../stream-abort-registry');

      const { controller } = registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'stream-abc',
        messageId: 'msg-123',
      });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-123', userId: 'user-123' });

      expect(result.aborted).toBe(true);
      expect(result.reason).toBe('Stream aborted by user request');
      expect(controller.signal.aborted).toBe(true);
    });

    it('returns not found when no messageId was registered', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-123', streamId: 'stream-abc' });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-unknown', userId: 'user-123' });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Stream not found or already completed');
    });

    it('fails for different userId (IDOR protection via messageId)', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'stream-abc',
        messageId: 'msg-123',
      });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-123', userId: 'attacker-456' });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Unauthorized to abort this stream');
    });

    it('cleans up messageIdIndex entry after abort', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'stream-abc',
        messageId: 'msg-123',
      });

      registry.abortStreamByMessageId({ messageId: 'msg-123', userId: 'user-123' });

      // Second call should find nothing
      const result = registry.abortStreamByMessageId({ messageId: 'msg-123', userId: 'user-123' });
      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Stream not found or already completed');
    });
  });

  describe('removeStream with messageId cleanup', () => {
    it('cleans up messageIdIndex entry on removeStream', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({
        userId: 'user-123',
        streamId: 'stream-abc',
        messageId: 'msg-123',
      });

      registry.removeStream({ streamId: 'stream-abc' });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-123', userId: 'user-123' });
      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Stream not found or already completed');
    });

    it('given many unrelated streamIds in the registry, should still resolve the messageId reverse-lookup correctly on removeStream', async () => {
      const registry = await import('../stream-abort-registry');

      for (let i = 0; i < 1000; i++) {
        registry.createStreamAbortController({ userId: `u-${i}`, streamId: `s-${i}` });
      }
      registry.createStreamAbortController({
        userId: 'user-target',
        streamId: 'stream-target',
        messageId: 'msg-target',
      });

      registry.removeStream({ streamId: 'stream-target' });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-target', userId: 'user-target' });
      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Stream not found or already completed');
    });

    it('given a messageId is re-linked to a new streamId, should let the new streamId resolve via abortStreamByMessageId', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'old-stream', messageId: 'msg-1' });
      registry.createStreamAbortController({ userId: 'user-1', streamId: 'new-stream', messageId: 'msg-1' });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-1', userId: 'user-1' });

      expect(result.aborted).toBe(true);
      expect(registry.isStreamActive({ streamId: 'new-stream' })).toBe(false);
    });

    it('given a messageId is re-linked, should not leak stale reverse entries that point at the old streamId', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'old-stream', messageId: 'msg-1' });
      registry.createStreamAbortController({ userId: 'user-1', streamId: 'new-stream', messageId: 'msg-1' });

      // Removing the old (now-orphaned) streamId must not delete the messageId index
      // entry that now points at new-stream.
      registry.removeStream({ streamId: 'old-stream' });

      const result = registry.abortStreamByMessageId({ messageId: 'msg-1', userId: 'user-1' });
      expect(result.aborted).toBe(true);
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

  // The terminal write has to ride the abort, because the callbacks that would otherwise perform
  // it are not reachable on every path — both generation routes say so in their own comments:
  // `onAbort` only fires while a streamText is live, and `onFinish` "may never fire when the
  // mobile client backgrounds mid-stream" (which is precisely the population of a cross-instance
  // abort — the client went away, which is the whole reason the stream is server-owned).
  //
  // A cross-instance Stop now WAITS for the row to go terminal before deciding what to tell the
  // user. If a stopped stream's row never settled, the user would be warned that their agent is
  // "still running and still billing" when it is already dead — a false alarm on the one message
  // that must never be false.
  describe('attachStreamFinisher', () => {
    it('drives the stream terminal as part of aborting it', async () => {
      const registry = await import('../stream-abort-registry');
      const finish = vi.fn();

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1' });
      registry.attachStreamFinisher({ streamId: 'stream-1', finish });

      registry.abortStream({ streamId: 'stream-1', userId: 'user-1' });

      expect(finish).toHaveBeenCalledWith(true);
    });

    // The IDOR guard runs first. A refused abort must not write a terminal status either, or a
    // stranger could mark another user's live generation as finished without stopping it — hiding
    // a running stream from every subscriber while it kept generating.
    it('does not finish a stream whose abort was refused', async () => {
      const registry = await import('../stream-abort-registry');
      const finish = vi.fn();

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1' });
      registry.attachStreamFinisher({ streamId: 'stream-1', finish });

      registry.abortStream({ streamId: 'stream-1', userId: 'user-2' });

      expect(finish).not.toHaveBeenCalled();
    });
  });

  // A generation ends well before its ROW does: onFinish unregisters the controller immediately and
  // only writes the terminal status at the very end, after persisting the message and billing each
  // tool call. For that whole window the row still reads 'streaming' with a live heartbeat.
  //
  // Without a tombstone, a Stop pressed in that window — as the last tokens render, one of the most
  // common Stop clicks there is — is indistinguishable from a stream owned by ANOTHER instance. It
  // would be escalated, time out against that live heartbeat, and warn the user their agent is
  // "still running and still billing". It finished. The honest answer is silence.
  describe('wasRecentlyFinishedHere', () => {
    it('remembers a stream this process ran to completion, under both of its names', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.removeStream({ streamId: 'stream-1' });

      expect(registry.wasRecentlyFinishedHere({ messageId: 'msg-1' })).toBe(true);
      expect(registry.wasRecentlyFinishedHere({ streamId: 'stream-1' })).toBe(true);
    });

    // The distinction the whole tombstone exists to draw. A stream this instance never ran must NOT
    // look finished — it belongs to someone else, and its Stop has to be escalated to them.
    it('does not claim a stream it never owned', async () => {
      const registry = await import('../stream-abort-registry');

      expect(registry.wasRecentlyFinishedHere({ messageId: 'msg-elsewhere' })).toBe(false);
      expect(registry.wasRecentlyFinishedHere({ streamId: 'stream-elsewhere' })).toBe(false);
    });

    // The tombstone must never become the very bug it exists to prevent. If a messageId (or
    // streamId) is reused by a NEW generation, the stale tombstone would answer for the DEAD one:
    // a Stop aimed at the live stream would be reported as "nothing in flight" and swallowed in
    // silence, while it kept generating and kept billing.
    it('forgets a finished stream the moment its name is reused by a new generation', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.removeStream({ streamId: 'stream-1' });
      expect(registry.wasRecentlyFinishedHere({ messageId: 'msg-1' })).toBe(true);

      // The same messageId re-registers — a new, LIVE generation.
      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-2', messageId: 'msg-1' });

      assert({
        given: 'a messageId reused by a new generation after a previous one finished',
        should: 'no longer report it as finished — a Stop for the LIVE stream must not be swallowed',
        actual: registry.wasRecentlyFinishedHere({ messageId: 'msg-1' }),
        expected: false,
      });
    });

    it('forgets a finished stream when its streamId is reused', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.removeStream({ streamId: 'stream-1' });

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-2' });

      assert({
        given: 'a streamId reused by a new generation',
        should: 'no longer report it as finished',
        actual: registry.wasRecentlyFinishedHere({ streamId: 'stream-1' }),
        expected: false,
      });
    });

    // An abort ends the stream here just as surely as a natural finish, and leaves the same window:
    // the terminal write is fire-and-forget, so the row still reads 'streaming' with a fresh
    // heartbeat for a moment. A SECOND Stop naming it (a double-click, or a surface that aborts by
    // messageId) would otherwise escalate and time out against that live heartbeat — warning that a
    // generation is "still running and still billing" seconds after we killed it ourselves.
    it('remembers a stream it ABORTED, not only one that finished naturally', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.abortStream({ streamId: 'stream-1', userId: 'user-1' });

      expect(registry.wasRecentlyFinishedHere({ streamId: 'stream-1' })).toBe(true);
      assert({
        given: 'a second Stop naming a stream this instance already aborted',
        should: 'know it is over — under its messageId too, which is the name most surfaces use',
        actual: registry.wasRecentlyFinishedHere({ messageId: 'msg-1' }),
        expected: true,
      });
    });

    // A REFUSED abort (wrong user) must not tombstone: the stream is still running, and a later
    // Stop from its real owner has to escalate.
    it('does not remember a stream whose abort was refused', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.abortStream({ streamId: 'stream-1', userId: 'user-2' });

      expect(registry.wasRecentlyFinishedHere({ messageId: 'msg-1' })).toBe(false);
    });

    it('does not claim a stream that is still running here', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });

      expect(registry.wasRecentlyFinishedHere({ messageId: 'msg-1' })).toBe(false);
    });
  });

  describe('listLocalStreams', () => {
    // The abort watcher's notion of "mine". A stream missing from this list would never have its
    // cross-instance abort request consumed.
    it('reports the streams this process owns, with their owners', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.createStreamAbortController({ userId: 'user-2', streamId: 'stream-2', messageId: 'msg-2' });

      expect(registry.listLocalStreams()).toEqual([
        { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-1' },
        { messageId: 'msg-2', streamId: 'stream-2', userId: 'user-2' },
      ]);
    });

    it('forgets a stream once it has been aborted', async () => {
      const registry = await import('../stream-abort-registry');

      registry.createStreamAbortController({ userId: 'user-1', streamId: 'stream-1', messageId: 'msg-1' });
      registry.abortStream({ streamId: 'stream-1', userId: 'user-1' });

      expect(registry.listLocalStreams()).toEqual([]);
    });
  });
});

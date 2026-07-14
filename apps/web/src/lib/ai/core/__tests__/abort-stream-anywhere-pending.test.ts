import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  abortStream: vi.fn(),
  abortStreamByMessageId: vi.fn(),
  wasRecentlyFinishedHere: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/ai/core/abort-conversation-streams', () => ({
  abortConversationStreams: vi.fn(),
}));

vi.mock('@/lib/ai/core/stream-abort-mark', () => ({
  markAbortRequested: vi.fn(),
  awaitAbortSettled: vi.fn(),
  reconcileDeadStreamRows: vi.fn(),
}));

vi.mock('@/lib/ai/core/pending-abort-intents', () => ({
  recordPendingAbort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ai/core/stream-abort-decisions', () => ({
  // AbortCode type is importable from the real module
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

import { abortStreamAnywhere } from '@/lib/ai/core/abort-stream-anywhere';
import { abortStream, abortStreamByMessageId, wasRecentlyFinishedHere } from '@/lib/ai/core/stream-abort-registry';
import { abortConversationStreams } from '@/lib/ai/core/abort-conversation-streams';
import { markAbortRequested, awaitAbortSettled, reconcileDeadStreamRows } from '@/lib/ai/core/stream-abort-mark';
import { recordPendingAbort } from '@/lib/ai/core/pending-abort-intents';

describe('abortStreamAnywhere', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(abortStream).mockReturnValue({ aborted: false, reason: 'not found' });
    vi.mocked(abortStreamByMessageId).mockReturnValue({ aborted: false, reason: 'not found' });
    vi.mocked(wasRecentlyFinishedHere).mockReturnValue(false);
    vi.mocked(abortConversationStreams).mockResolvedValue({ aborted: [] });
    vi.mocked(markAbortRequested).mockResolvedValue({ marked: [], failed: false });
    vi.mocked(awaitAbortSettled).mockResolvedValue({ aborted: [], reconcile: [], stillLive: [], code: 'aborted' });
    vi.mocked(reconcileDeadStreamRows).mockResolvedValue(undefined);
    vi.mocked(recordPendingAbort).mockResolvedValue(undefined);
  });

  describe('pending-abort intent recording (#2028 item 1)', () => {
    it('records a pending-abort intent when nothing is found', async () => {
      const result = await abortStreamAnywhere({
        conversationId: 'conv1',
        userId: 'user1',
      });

      expect(recordPendingAbort).toHaveBeenCalledWith({
        conversationId: 'conv1',
        userId: 'user1',
      });
      expect(result.code).toBe('not_found');
    });

    it('does NOT record a pending-abort when streams were locally aborted', async () => {
      vi.mocked(abortConversationStreams).mockResolvedValue({ aborted: ['msg1'] });

      const result = await abortStreamAnywhere({
        conversationId: 'conv1',
        userId: 'user1',
      });

      expect(recordPendingAbort).not.toHaveBeenCalled();
      expect(result.code).toBe('aborted');
    });

    it('does NOT record a pending-abort when rows were marked', async () => {
      vi.mocked(markAbortRequested).mockResolvedValue({ marked: ['msg1'], failed: false });
      // Make wasRecentlyFinishedHere return true so awaiting is empty (simulates cross-instance)
      vi.mocked(wasRecentlyFinishedHere).mockReturnValue(true);

      const result = await abortStreamAnywhere({
        conversationId: 'conv1',
        userId: 'user1',
      });

      expect(recordPendingAbort).not.toHaveBeenCalled();
    });

    it('does NOT record a pending-abort when no conversationId is provided', async () => {
      const result = await abortStreamAnywhere({
        streamId: 'stream1',
        userId: 'user1',
      });

      expect(recordPendingAbort).not.toHaveBeenCalled();
    });
  });

  describe('item 4a: false unconfirmed when locally aborted', () => {
    it('returns aborted when mark fails but streams were locally aborted', async () => {
      vi.mocked(abortConversationStreams).mockResolvedValue({ aborted: ['msg1'] });
      vi.mocked(markAbortRequested).mockResolvedValue({ marked: [], failed: true });

      const result = await abortStreamAnywhere({
        conversationId: 'conv1',
        userId: 'user1',
      });

      expect(result.aborted).toBe(true);
      expect(result.code).toBe('aborted');
    });

    it('returns unconfirmed when mark fails and nothing was locally aborted', async () => {
      vi.mocked(abortConversationStreams).mockResolvedValue({ aborted: [] });
      vi.mocked(markAbortRequested).mockResolvedValue({ marked: [], failed: true });

      const result = await abortStreamAnywhere({
        conversationId: 'conv1',
        userId: 'user1',
      });

      expect(result.aborted).toBe(false);
      expect(result.code).toBe('unconfirmed');
    });
  });
});

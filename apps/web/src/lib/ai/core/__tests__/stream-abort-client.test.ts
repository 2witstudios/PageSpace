import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fetchWithAuth
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

describe('stream-abort-client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('setActiveStreamId / getActiveStreamId', () => {
    it('stores and retrieves streamId for chatId', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      const result = client.getActiveStreamId({ chatId: 'chat-123' });
      expect(result).toBe('stream-456');
    });

    it('returns undefined for unknown chatId', async () => {
      const client = await import('../stream-abort-client');

      const result = client.getActiveStreamId({ chatId: 'unknown-chat' });
      expect(result).toBeUndefined();
    });

    it('overwrites previous streamId for same chatId', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-old',
      });

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-new',
      });

      const result = client.getActiveStreamId({ chatId: 'chat-123' });
      expect(result).toBe('stream-new');
    });
  });

  describe('clearActiveStreamId', () => {
    it('removes streamId for chatId', async () => {
      const client = await import('../stream-abort-client');

      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      client.clearActiveStreamId({ chatId: 'chat-123' });

      const result = client.getActiveStreamId({ chatId: 'chat-123' });
      expect(result).toBeUndefined();
    });

    it('handles clearing non-existent chatId gracefully', async () => {
      const client = await import('../stream-abort-client');

      // Should not throw
      expect(() => {
        client.clearActiveStreamId({ chatId: 'non-existent' });
      }).not.toThrow();
    });
  });

  describe('abortActiveStream', () => {
    it('calls abort endpoint and clears state on success', async () => {
      const client = await import('../stream-abort-client');

      // Setup active stream
      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      // Mock successful abort response
      vi.mocked(fetchWithAuth).mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({
          aborted: true,
          reason: 'Stream aborted by user request',
        }),
      } as unknown as Response);

      const result = await client.abortActiveStream({ chatId: 'chat-123' });

      expect(result.aborted).toBe(true);
      expect(result.reason).toBe('Stream aborted by user request');

      // Verify fetch was called correctly
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/ai/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId: 'stream-456' }),
      });

      // Verify streamId was cleared
      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBeUndefined();
    });

    it('returns failure when no active stream exists', async () => {
      const client = await import('../stream-abort-client');

      const result = await client.abortActiveStream({ chatId: 'chat-123' });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('No active stream for this chat');
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('handles fetch error gracefully', async () => {
      const client = await import('../stream-abort-client');

      // Setup active stream
      client.setActiveStreamId({
        chatId: 'chat-123',
        streamId: 'stream-456',
      });

      // Mock fetch error
      vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('Network error'));

      const result = await client.abortActiveStream({ chatId: 'chat-123' });

      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Failed to call abort endpoint');
    });
  });

  describe('createStreamTrackingFetch', () => {
    it('extracts X-Stream-Id header and stores it', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        headers: {
          get: vi.fn().mockReturnValue('extracted-stream-id'),
        },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ chatId: 'chat-123' });
      await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(mockResponse.headers.get).toHaveBeenCalledWith('X-Stream-Id');
      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBe('extracted-stream-id');
    });

    it('does not set streamId when header is missing', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        headers: {
          get: vi.fn().mockReturnValue(null),
        },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ chatId: 'chat-123' });
      await trackingFetch('/api/ai/chat', { method: 'POST' });

      expect(client.getActiveStreamId({ chatId: 'chat-123' })).toBeUndefined();
    });

    it('handles Request object as URL', async () => {
      const client = await import('../stream-abort-client');

      const mockResponse = {
        headers: {
          get: vi.fn().mockReturnValue('stream-id'),
        },
      } as unknown as Response;

      vi.mocked(fetchWithAuth).mockResolvedValueOnce(mockResponse);

      const trackingFetch = client.createStreamTrackingFetch({ chatId: 'chat-123' });
      const request = new Request('https://example.com/api/ai/chat');
      await trackingFetch(request, {});

      expect(fetchWithAuth).toHaveBeenCalledWith('https://example.com/api/ai/chat', {});
    });
  });

});

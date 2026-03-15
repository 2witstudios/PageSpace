import { describe, it, expect, vi } from 'vitest';

// Mock the stream-abort-client module
vi.mock('../stream-abort-client', () => ({
  abortActiveStream: vi.fn(),
  createStreamTrackingFetch: vi.fn(),
  setActiveStreamId: vi.fn(),
  getActiveStreamId: vi.fn(),
  clearActiveStreamId: vi.fn(),
}));

// Mock @/lib/auth/auth-fetch (used by stream-abort-client)
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import * as clientModule from '../client';

describe('client', () => {
  describe('module exports', () => {
    it('should export abortActiveStream', () => {
      expect(clientModule).toHaveProperty('abortActiveStream');
      expect(typeof clientModule.abortActiveStream).toBe('function');
    });

    it('should export createStreamTrackingFetch', () => {
      expect(clientModule).toHaveProperty('createStreamTrackingFetch');
      expect(typeof clientModule.createStreamTrackingFetch).toBe('function');
    });

    it('should export setActiveStreamId', () => {
      expect(clientModule).toHaveProperty('setActiveStreamId');
      expect(typeof clientModule.setActiveStreamId).toBe('function');
    });

    it('should export getActiveStreamId', () => {
      expect(clientModule).toHaveProperty('getActiveStreamId');
      expect(typeof clientModule.getActiveStreamId).toBe('function');
    });

    it('should export clearActiveStreamId', () => {
      expect(clientModule).toHaveProperty('clearActiveStreamId');
      expect(typeof clientModule.clearActiveStreamId).toBe('function');
    });

    it('should re-export the same functions as stream-abort-client', async () => {
      const streamAbortClient = await import('../stream-abort-client');

      expect(clientModule.abortActiveStream).toBe(streamAbortClient.abortActiveStream);
      expect(clientModule.createStreamTrackingFetch).toBe(streamAbortClient.createStreamTrackingFetch);
      expect(clientModule.setActiveStreamId).toBe(streamAbortClient.setActiveStreamId);
      expect(clientModule.getActiveStreamId).toBe(streamAbortClient.getActiveStreamId);
      expect(clientModule.clearActiveStreamId).toBe(streamAbortClient.clearActiveStreamId);
    });
  });
});

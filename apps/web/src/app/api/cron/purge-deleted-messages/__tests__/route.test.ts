/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/purge-deleted-messages
//
// Tests hard-deletion of soft-deleted messages and conversations older than 30 days.
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    purgeInactiveMessages: vi.fn(),
  },
}));

vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    purgeInactiveMessages: vi.fn(),
    purgeInactiveConversations: vi.fn(),
  },
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

// ============================================================================
// GET /api/cron/purge-deleted-messages - Contract Tests
// ============================================================================

describe('GET /api/cron/purge-deleted-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  describe('authentication', () => {
    it('should return auth error when cron request is invalid', async () => {
      const errorResponse = NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success', () => {
    it('should return purge counts for all message types', async () => {
      vi.mocked(chatMessageRepository.purgeInactiveMessages).mockResolvedValue(5);
      vi.mocked(globalConversationRepository.purgeInactiveMessages).mockResolvedValue(3);
      vi.mocked(globalConversationRepository.purgeInactiveConversations).mockResolvedValue(1);

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.chatMessagesPurged).toBe(5);
      expect(body.globalMessagesPurged).toBe(3);
      expect(body.conversationsPurged).toBe(1);
      expect(body.timestamp).toBeDefined();
    });

    it('should return 0 counts when no messages need purging', async () => {
      vi.mocked(chatMessageRepository.purgeInactiveMessages).mockResolvedValue(0);
      vi.mocked(globalConversationRepository.purgeInactiveMessages).mockResolvedValue(0);
      vi.mocked(globalConversationRepository.purgeInactiveConversations).mockResolvedValue(0);

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.chatMessagesPurged).toBe(0);
      expect(body.globalMessagesPurged).toBe(0);
      expect(body.conversationsPurged).toBe(0);
    });

    it('should pass a date approximately 30 days ago to purge functions', async () => {
      vi.mocked(chatMessageRepository.purgeInactiveMessages).mockResolvedValue(0);
      vi.mocked(globalConversationRepository.purgeInactiveMessages).mockResolvedValue(0);
      vi.mocked(globalConversationRepository.purgeInactiveConversations).mockResolvedValue(0);

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      await GET(request);

      const calledDate = vi.mocked(chatMessageRepository.purgeInactiveMessages).mock.calls[0][0] as Date;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const delta = Math.abs(Date.now() - calledDate.getTime() - thirtyDaysMs);
      expect(delta).toBeLessThan(5000);
    });
  });

  describe('error handling', () => {
    it('should return 500 when chat message purge throws', async () => {
      vi.mocked(chatMessageRepository.purgeInactiveMessages).mockRejectedValue(new Error('DB error'));

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('DB error');
    });

    it('should return 500 when global conversation purge throws', async () => {
      vi.mocked(chatMessageRepository.purgeInactiveMessages).mockResolvedValue(0);
      vi.mocked(globalConversationRepository.purgeInactiveMessages).mockResolvedValue(0);
      vi.mocked(globalConversationRepository.purgeInactiveConversations).mockRejectedValue(
        new Error('Conversation purge failed')
      );

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Conversation purge failed');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(chatMessageRepository.purgeInactiveMessages).mockRejectedValue(null);

      const request = new Request('http://localhost/api/cron/purge-deleted-messages');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/purge-deleted-messages - Delegates to GET
// ============================================================================

describe('POST /api/cron/purge-deleted-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('should delegate to GET handler', async () => {
    vi.mocked(chatMessageRepository.purgeInactiveMessages).mockResolvedValue(2);
    vi.mocked(globalConversationRepository.purgeInactiveMessages).mockResolvedValue(1);
    vi.mocked(globalConversationRepository.purgeInactiveConversations).mockResolvedValue(0);

    const request = new Request('http://localhost/api/cron/purge-deleted-messages', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.chatMessagesPurged).toBe(2);
  });
});

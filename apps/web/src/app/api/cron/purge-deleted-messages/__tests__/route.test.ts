/**
 * Contract tests for /api/cron/purge-deleted-messages
 * Verifies security audit logging on successful message purge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockChatRepo, mockGlobalRepo, mockAudit } = vi.hoisted(() => ({
  mockChatRepo: { purgeInactiveMessages: vi.fn() },
  mockGlobalRepo: { purgeInactiveMessages: vi.fn(), purgeInactiveConversations: vi.fn() },
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: mockChatRepo,
}));

vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: mockGlobalRepo,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
    audit: mockAudit,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/purge-deleted-messages');
}

describe('/api/cron/purge-deleted-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockChatRepo.purgeInactiveMessages.mockResolvedValue(5);
    mockGlobalRepo.purgeInactiveMessages.mockResolvedValue(3);
    mockGlobalRepo.purgeInactiveConversations.mockResolvedValue(2);
  });

  it('logs audit event on successful purge', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'purge_deleted_messages', details: { chatMessagesPurged: 5, globalMessagesPurged: 3, conversationsPurged: 2 } })
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not log audit event when purge throws', async () => {
    mockChatRepo.purgeInactiveMessages.mockRejectedValue(new Error('DB error'));

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });
});

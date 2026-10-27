/**
 * Contract tests for /api/cron/purge-deleted-messages
 * Verifies security audit logging on successful message purge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Since the message-table merge (epic "Agent-Session Single Source of Truth",
// Phase 4 / D6) `purgeInactiveMessages` sweeps the ONE `messages` table, page
// rows included. The separate legacy sweep went with `chat_messages` at PR 15.
// `globalConversationRepository` keeps only the CONVERSATION purge.
const { mockMessageRepo, mockGlobalRepo, mockDmRepo, mockAudit } = vi.hoisted(() => ({
  mockMessageRepo: { purgeInactiveMessages: vi.fn() },
  mockGlobalRepo: { purgeInactiveConversations: vi.fn() },
  mockDmRepo: { purgeInactiveMessages: vi.fn() },
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/repositories/message-repository', () => ({
  messageRepository: mockMessageRepo,
}));

vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: mockGlobalRepo,
}));

vi.mock('@pagespace/lib/services/dm-message-repository', () => ({
  dmMessageRepository: mockDmRepo,
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
    mockMessageRepo.purgeInactiveMessages.mockResolvedValue(3);
    mockGlobalRepo.purgeInactiveConversations.mockResolvedValue(2);
    mockDmRepo.purgeInactiveMessages.mockResolvedValue(4);
  });

  it('logs audit event on successful purge', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.delete',
        resourceType: 'cron_job',
        resourceId: 'purge_deleted_messages',
        details: {
          globalMessagesPurged: 3,
          directMessagesPurged: 4,
          conversationsPurged: 2,
        },
      })
    );
  });

  it('returns direct message purge count in the retention response', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(mockDmRepo.purgeInactiveMessages).toHaveBeenCalledTimes(1);
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        directMessagesPurged: 4,
      })
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not log audit event when purge throws', async () => {
    mockMessageRepo.purgeInactiveMessages.mockRejectedValue(new Error('DB error'));

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });
});

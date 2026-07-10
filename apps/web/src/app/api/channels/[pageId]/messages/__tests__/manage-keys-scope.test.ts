/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, mintable today
 * via the manage_keys scope token — see ScopeSet.manageKeys) must not be able
 * to read a channel's messages. Uses the REAL checkMCPPageScope/
 * isManageKeysOnly implementation (not mocked) so this fails if the
 * hardening in apps/web/src/lib/auth/index.ts regresses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

const mockPageFindFirst = vi.fn().mockResolvedValue(null);
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: (...args: unknown[]) => mockPageFindFirst(...args) },
      driveMembers: { findMany: vi.fn().mockResolvedValue([]) },
    },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ driveMembers: {}, pagePermissions: {} }));

vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    listChannelMessages: vi.fn(),
    listChannelThreadReplies: vi.fn(),
    findChannelMessageInPage: vi.fn(),
    insertChannelMessageWithAttachment: vi.fn(),
    insertChannelThreadReply: vi.fn(),
    upsertChannelReadStatus: vi.fn(),
    loadChannelMessageWithRelations: vi.fn(),
    listChannelThreadFollowers: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    realtime: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn(),
  broadcastThreadReplyCountUpdated: vi.fn(),
}));

// Only stub authentication — checkMCPPageScope and isManageKeysOnly run for real.
vi.mock('@/lib/auth/request-auth', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticateRequestWithOptions: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

describe('GET /api/channels/[pageId]/messages — manage-keys-only credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageFindFirst.mockResolvedValue(null);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
  });

  it('denies reading channel messages with 403 instead of the empty-allowedDriveIds full-access default, without a page lookup', async () => {
    const request = new Request('https://example.com/api/channels/page-1/messages');

    const response = await GET(request, { params: Promise.resolve({ pageId: 'page-1' }) });

    expect(response.status).toBe(403);
    expect(mockPageFindFirst).not.toHaveBeenCalled();
  });
});

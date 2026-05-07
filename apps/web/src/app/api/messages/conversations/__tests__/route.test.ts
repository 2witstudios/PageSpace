/**
 * DM eligibility tests for POST /api/messages/conversations.
 * The route should allow conversation creation when the users have an
 * ACCEPTED connection OR share a drive (owner or accepted member).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: {},
  connections: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  usersShareDrive: vi.fn(),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn(() => 20),
}));
vi.mock('@/lib/utils/timestamp', () => ({
  toISOTimestamp: vi.fn((v: unknown) => (v instanceof Date ? v.toISOString() : v)),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { usersShareDrive } from '@pagespace/lib/permissions/permissions';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';

const userId = 'user_self';
const recipientId = 'user_other';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function insertChain(rows: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.insert>;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/messages/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/messages/conversations DM eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(isEmailVerified).mockResolvedValue(true);
  });

  it('allows DM when an accepted connection exists', async () => {
    vi.mocked(usersShareDrive).mockResolvedValue(false);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: 'conn_1' }]))
      .mockReturnValueOnce(selectChain([]));
    vi.mocked(db.insert).mockReturnValueOnce(
      insertChain([{ id: 'conv_1', participant1Id: userId, participant2Id: recipientId }])
    );

    const response = await POST(makeRequest({ recipientId }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversation.id).toBe('conv_1');
    expect(usersShareDrive).not.toHaveBeenCalled();
  });

  it('allows DM via shared drive even when no connection exists', async () => {
    vi.mocked(usersShareDrive).mockResolvedValue(true);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]));
    vi.mocked(db.insert).mockReturnValueOnce(
      insertChain([{ id: 'conv_2', participant1Id: userId, participant2Id: recipientId }])
    );

    const response = await POST(makeRequest({ recipientId }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversation.id).toBe('conv_2');
    expect(usersShareDrive).toHaveBeenCalledWith(userId, recipientId);
  });

  it('returns 403 when neither a connection nor a shared drive exists', async () => {
    vi.mocked(usersShareDrive).mockResolvedValue(false);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]));

    const response = await POST(makeRequest({ recipientId }));

    expect(response.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns existing conversation without insert when one already exists', async () => {
    vi.mocked(usersShareDrive).mockResolvedValue(true);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([])) // no connection
      .mockReturnValueOnce(selectChain([{ id: 'existing_conv' }]));

    const response = await POST(makeRequest({ recipientId }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversation.id).toBe('existing_conv');
    expect(db.insert).not.toHaveBeenCalled();
  });
});

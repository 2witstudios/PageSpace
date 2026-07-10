/**
 * DM eligibility tests for POST /api/messages/conversations.
 * The route should allow conversation creation when the users have an
 * ACCEPTED connection OR share a drive (owner or accepted member).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
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

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request instead of once per row. A bare `vi.spyOn` doesn't work
// here because `@pagespace/lib` resolves to its built CJS dist output, and the
// per-row-dedup internals (decryptUserRow -> decryptField) are a *nested*
// require inside that compiled module, invisible to any mock at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET, POST } from '../route';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { db } from '@pagespace/db/db';
import { usersShareDrive } from '@pagespace/lib/permissions/permissions';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

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
      .mockReturnValueOnce(selectChain([{ status: 'ACCEPTED' }]))
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

  it('returns 403 when the relationship is BLOCKED, even if users share a drive', async () => {
    vi.mocked(usersShareDrive).mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ status: 'BLOCKED' }]));

    const response = await POST(makeRequest({ recipientId }));

    expect(response.status).toBe(403);
    expect(usersShareDrive).not.toHaveBeenCalled();
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

describe('GET /api/messages/conversations PII decryption dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  const conversationRow = (overrides: Record<string, unknown>) => ({
    id: 'conv_1',
    participant1Id: userId,
    participant2Id: recipientId,
    lastMessageAt: '2026-05-03T00:00:00.000Z',
    lastMessagePreview: 'hi',
    participant1LastRead: null,
    participant2LastRead: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    last_read: null,
    other_user_id: recipientId,
    other_user_name: 'Other',
    other_user_email: 'other@example.com',
    other_user_image: null,
    other_user_username: 'other',
    other_user_display_name: null,
    other_user_avatar_url: null,
    unread_count: '0',
    ...overrides,
  });

  it('decrypts one counterpart repeated across conversation rows only once (dedup)', async () => {
    const encryptedName = await encryptField('Real Name');
    const encryptedEmail = await encryptField('real@example.com');
    const rows = Array.from({ length: 4 }, (_, i) =>
      conversationRow({ id: `conv_${i}`, other_user_name: encryptedName, other_user_email: encryptedEmail })
    );
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const response = await GET(new Request('http://localhost/api/messages/conversations'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations).toHaveLength(4);
    for (const conversation of body.conversations) {
      expect(conversation.otherUser.name).toBe('Real Name');
      expect(conversation.otherUser.email).toBe('real@example.com');
    }
    // Decryption is batched once per request (dedup happens inside), not
    // once per of the 4 conversation rows.
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decryptUsersByIdOnce).mock.calls[0][0]).toHaveLength(4);
  });

  it('passes through legacy plaintext name/email unchanged', async () => {
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [conversationRow({})],
    });

    const response = await GET(new Request('http://localhost/api/messages/conversations'));
    const body = await response.json();

    expect(body.conversations[0].otherUser.name).toBe('Other');
    expect(body.conversations[0].otherUser.email).toBe('other@example.com');
  });

  it('does not crash when the counterpart user row is gone (deleted user)', async () => {
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [conversationRow({ other_user_id: null, other_user_name: null, other_user_email: null })],
    });

    const response = await GET(new Request('http://localhost/api/messages/conversations'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations[0].otherUser.name).toBeNull();
    expect(body.conversations[0].otherUser.email).toBeNull();
  });
});

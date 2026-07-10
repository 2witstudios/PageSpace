/**
 * PII decryption tests for GET /api/messages/conversations/[conversationId].
 * The single-conversation detail must decrypt the counterpart's name/email
 * through the same request-batched decryptUsersByIdOnce path as the list
 * routes (GDPR #965 perf remediation round 2).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { execute: vi.fn() },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request. A bare `vi.spyOn` doesn't work here because
// `@pagespace/lib` resolves to its built CJS dist output, and the
// per-row-dedup internals (decryptUserRow -> decryptField) are a *nested*
// require inside that compiled module, invisible to any mock at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const mockUserId = 'user_123';
const otherUserId = 'user_other';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

const detailRow = (overrides: Record<string, unknown>) => ({
  id: 'conv_1',
  participant1Id: mockUserId,
  participant2Id: otherUserId,
  lastMessageAt: '2026-05-03T00:00:00.000Z',
  lastMessagePreview: 'hi',
  createdAt: '2026-05-01T00:00:00.000Z',
  other_user_id: otherUserId,
  user_id: otherUserId,
  user_name: 'Other',
  user_email: 'other@example.com',
  user_image: null,
  user_username: 'other',
  user_display_name: null,
  user_avatar_url: null,
  ...overrides,
});

const makeRequest = () =>
  GET(new Request('http://localhost/api/messages/conversations/conv_1'), {
    params: Promise.resolve({ conversationId: 'conv_1' }),
  });

describe('GET /api/messages/conversations/[conversationId] PII decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('decrypts the single counterpart name/email in one batched call', async () => {
    const encryptedName = await encryptField('Real Name');
    const encryptedEmail = await encryptField('real@example.com');
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [detailRow({ user_name: encryptedName, user_email: encryptedEmail })],
    });

    const response = await makeRequest();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversation.otherUser.name).toBe('Real Name');
    expect(body.conversation.otherUser.email).toBe('real@example.com');
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
  });

  it('passes through legacy plaintext name/email unchanged', async () => {
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [detailRow({})],
    });

    const response = await makeRequest();
    const body = await response.json();

    expect(body.conversation.otherUser.name).toBe('Other');
    expect(body.conversation.otherUser.email).toBe('other@example.com');
  });

  it('does not crash when the counterpart user row is gone (deleted user)', async () => {
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [detailRow({ user_id: null, user_name: null, user_email: null })],
    });

    const response = await makeRequest();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversation.otherUser.name).toBeNull();
    expect(body.conversation.otherUser.email).toBeNull();
  });

  it('returns 404 when the conversation does not exist for this user', async () => {
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const response = await makeRequest();

    expect(response.status).toBe(404);
  });
});

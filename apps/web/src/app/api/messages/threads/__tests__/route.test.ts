/**
 * PII decryption tests for GET /api/messages/threads.
 * The DM thread list must decrypt each unique counterpart's name/email once
 * per request via decryptUsersByIdOnce, not once per conversation row
 * (GDPR #965 perf remediation round 2).
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

vi.mock('@pagespace/db/operators', () => {
  // Capture the literal text chunks so tests can identify which CTE ran.
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sqlText: strings.join('?'),
  });
  return { sql };
});

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
// once per request instead of once per row. A bare `vi.spyOn` doesn't work
// here because `@pagespace/lib` resolves to its built CJS dist output, and the
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

const dmRow = (overrides: Record<string, unknown>) => ({
  id: 'conv_1',
  participant1Id: mockUserId,
  participant2Id: otherUserId,
  lastMessageAt: '2026-05-03T00:00:00.000Z',
  lastMessagePreview: 'hi',
  participant1LastRead: null,
  participant2LastRead: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  last_read: null,
  other_user_id: otherUserId,
  other_user_name: 'Other',
  other_user_email: 'other@example.com',
  other_user_image: null,
  other_user_username: 'other',
  other_user_display_name: null,
  other_user_avatar_url: null,
  unread_count: '0',
  ...overrides,
});

const channelRow = {
  id: 'ch_1',
  title: 'general',
  driveId: 'drv_1',
  drive_name: 'Workspace',
  updatedAt: '2026-05-02T00:00:00.000Z',
  last_message: 'hello',
  last_message_at: '2026-05-02T00:00:00.000Z',
};

const isDmQuery = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && '__sqlText' in arg &&
  String((arg as { __sqlText: string }).__sqlText).includes('dm_conversations');

const mockExecute = (dmRows: unknown[], channelRows: unknown[]) => {
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (arg: unknown) => {
    if (isDmQuery(arg)) return { rows: dmRows };
    return { rows: channelRows };
  });
};

describe('GET /api/messages/threads PII decryption dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('decrypts one counterpart repeated across DM rows only once (dedup)', async () => {
    const encryptedName = await encryptField('Real Name');
    const encryptedEmail = await encryptField('real@example.com');
    const dmRows = Array.from({ length: 4 }, (_, i) =>
      dmRow({ id: `conv_${i}`, other_user_name: encryptedName, other_user_email: encryptedEmail })
    );
    mockExecute(dmRows, [channelRow]);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dms).toHaveLength(4);
    for (const dm of body.dms) {
      expect(dm.otherUser.name).toBe('Real Name');
      expect(dm.otherUser.email).toBe('real@example.com');
    }
    // Channels carry no PII columns; the request makes exactly one batched
    // decrypt call for the DM rows, not one per of the 4 rows.
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decryptUsersByIdOnce).mock.calls[0][0]).toHaveLength(4);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0].title).toBe('general');
  });

  it('passes through legacy plaintext name/email unchanged', async () => {
    mockExecute([dmRow({})], []);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(body.dms[0].otherUser.name).toBe('Other');
    expect(body.dms[0].otherUser.email).toBe('other@example.com');
  });

  it('does not crash when a counterpart user row is gone (deleted user)', async () => {
    mockExecute([dmRow({ other_user_id: null, other_user_name: null, other_user_email: null })], []);

    const response = await GET(new Request('http://localhost/api/messages/threads'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dms[0].otherUser.name).toBeNull();
    expect(body.dms[0].otherUser.email).toBeNull();
  });
});

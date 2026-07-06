/**
 * GDPR #965 — the admin magic-link send route looks up an admin user by email
 * before issuing a sign-in token. Verifies the dual-lookup helper
 * (`userEmailMatch`) is used instead of a raw `eq(users.email, …)` equality
 * match, which would silently stop finding users once PII_ENCRYPTION_ENABLED
 * writes ciphertext to `users.email`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

const { mockDbFindFirst, mockDbInsert, mockUserEmailMatch, mockSendEmail, mockCheckRateLimit } = vi.hoisted(() => ({
  mockDbFindFirst: vi.fn(),
  mockDbInsert: vi.fn(),
  mockUserEmailMatch: vi.fn((email: string) => ({ emailMatch: email })),
  mockSendEmail: vi.fn().mockResolvedValue(undefined),
  mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { users: { findFirst: mockDbFindFirst } },
    insert: mockDbInsert,
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email' },
  verificationTokens: {},
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  userEmailMatch: mockUserEmailMatch,
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  generateToken: vi.fn(() => ({ token: 'tok', hash: 'hash', tokenPrefix: 'ps_magic_abc' })),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('@pagespace/lib/email-templates/MagicLinkEmail', () => ({
  MagicLinkEmail: () => null,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mockCheckRateLimit,
  DISTRIBUTED_RATE_LIMITS: { MAGIC_LINK: { maxAttempts: 5 } },
}));

vi.mock('@pagespace/lib/auth/device-fingerprint-utils', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

process.env.ADMIN_URL = 'http://localhost:3005';

function makeRequest(email: string): Request {
  return new Request('http://localhost:3005/api/auth/magic-link/send', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/auth/magic-link/send', () => {
  beforeEach(() => {
    mockDbFindFirst.mockReset();
    mockDbInsert.mockReset();
    mockUserEmailMatch.mockClear();
    mockSendEmail.mockClear();
    mockCheckRateLimit.mockReset().mockResolvedValue({ allowed: true });
    mockDbInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  it('looks up the user via the dual-lookup helper, not a raw equality match', async () => {
    mockDbFindFirst.mockResolvedValueOnce({ id: 'admin-1', role: 'admin', suspendedAt: null });

    await POST(makeRequest('admin@example.com'));

    expect(mockUserEmailMatch).toHaveBeenCalledWith('admin@example.com');
  });

  it('sends a magic link when the user is an active admin', async () => {
    mockDbFindFirst.mockResolvedValueOnce({ id: 'admin-1', role: 'admin', suspendedAt: null });

    const res = await POST(makeRequest('admin@example.com'));

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it('returns generic success without sending an email for a non-admin/unknown user', async () => {
    mockDbFindFirst.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest('nobody@example.com'));

    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

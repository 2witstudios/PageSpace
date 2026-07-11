/**
 * GDPR #965 — admin-created users must go through the same encryption-aware
 * edge as every other user create path: the dedup check must use the
 * dual-lookup helper (not a raw equality match on `users.email`), and the
 * insert must be routed through `prepareUserWrite` so `emailBidx` is set.
 * Without this, admin-created users would be unfindable by blind index once
 * PII_ENCRYPTION_ENABLED is on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

const {
  mockDbFindFirst,
  mockDbInsertValues,
  mockUserEmailMatch,
  mockPrepareUserWrite,
  mockIsOnPrem,
  mockGenerateSetupLink,
} = vi.hoisted(() => ({
  mockDbFindFirst: vi.fn(),
  mockDbInsertValues: vi.fn().mockResolvedValue(undefined),
  mockUserEmailMatch: vi.fn((email: string) => ({ emailMatch: email })),
  mockPrepareUserWrite: vi.fn(async (values: Record<string, unknown>) => ({ ...values, emailBidx: 'bidx-of-' + values.email })),
  mockIsOnPrem: vi.fn(() => false),
  mockGenerateSetupLink: vi.fn(async () => 'http://web.local/api/auth/magic-link/verify?token=abc'),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { users: { findFirst: mockDbFindFirst } },
    insert: vi.fn(() => ({ values: mockDbInsertValues })),
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email' },
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  userEmailMatch: mockUserEmailMatch,
  prepareUserWrite: mockPrepareUserWrite,
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

vi.mock('@pagespace/lib/auth/onprem-setup-link', () => ({
  generateOnPremSetupLink: mockGenerateSetupLink,
}));

vi.mock('@pagespace/lib/onprem-defaults', () => ({
  getOnPremUserDefaults: vi.fn(() => ({})),
}));

vi.mock('@/lib/auth/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));

vi.mock('@/lib/onboarding/home-drive', () => ({
  provisionHomeDriveIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3005/api/admin/users/create', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/admin/users/create', () => {
  beforeEach(() => {
    mockDbFindFirst.mockReset();
    mockDbInsertValues.mockClear().mockResolvedValue(undefined);
    mockUserEmailMatch.mockClear();
    mockPrepareUserWrite.mockClear();
    mockIsOnPrem.mockReset().mockReturnValue(false);
    mockGenerateSetupLink.mockClear().mockResolvedValue('http://web.local/api/auth/magic-link/verify?token=abc');
  });

  it('checks for an existing user via the dual-lookup helper, not a raw equality match', async () => {
    mockDbFindFirst.mockResolvedValueOnce(undefined);

    await POST(makeRequest({ name: 'Jane Doe', email: 'jane@example.com' }));

    expect(mockUserEmailMatch).toHaveBeenCalledWith('jane@example.com');
  });

  it('returns 409 without inserting when a user with that email already exists', async () => {
    mockDbFindFirst.mockResolvedValueOnce({ id: 'existing-1' });

    const res = await POST(makeRequest({ name: 'Jane Doe', email: 'jane@example.com' }));

    expect(res.status).toBe(409);
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it('routes the insert through prepareUserWrite so emailBidx is set', async () => {
    mockDbFindFirst.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest({ name: 'Jane Doe', email: 'jane@example.com' }));

    expect(res.status).toBe(201);
    expect(mockPrepareUserWrite).toHaveBeenCalledOnce();
    expect(mockPrepareUserWrite.mock.calls[0][0]).toMatchObject({ email: 'jane@example.com' });
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jane@example.com', emailBidx: 'bidx-of-jane@example.com' })
    );
  });

  it('on-prem: returns a one-time setup link so the credential-less user can bootstrap a passkey', async () => {
    mockIsOnPrem.mockReturnValue(true);
    mockDbFindFirst.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest({ name: 'Jane Doe', email: 'jane@example.com' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockGenerateSetupLink).toHaveBeenCalledOnce();
    expect(body.setupLink).toBe('http://web.local/api/auth/magic-link/verify?token=abc');
  });

  it('cloud/tenant: does not mint or return a setup link (email delivery works there)', async () => {
    mockIsOnPrem.mockReturnValue(false);
    mockDbFindFirst.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest({ name: 'Jane Doe', email: 'jane@example.com' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockGenerateSetupLink).not.toHaveBeenCalled();
    expect(body.setupLink).toBeUndefined();
  });
});

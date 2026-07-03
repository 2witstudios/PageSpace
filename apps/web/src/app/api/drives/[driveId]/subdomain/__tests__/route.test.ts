import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract tests for the dedicated PATCH /api/drives/[driveId]/subdomain
// endpoint — the one true way to change publishSubdomain. These guard the
// existing behavior stays intact while the generic drive PATCH route now
// rejects publishSubdomain instead of silently dropping it.
// ============================================================================

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_col, val) => ({ __eq: val })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', ownerId: 'drives.ownerId', publishSubdomain: 'drives.publishSubdomain' },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' },
}));

vi.mock('@/lib/subscription/plans', () => ({
  getPlan: vi.fn(),
}));

const { MockPublishError } = vi.hoisted(() => {
  class MockPublishError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'PublishError';
      this.statusCode = statusCode;
    }
  }
  return { MockPublishError };
});

vi.mock('@/lib/canvas/publish-page', () => ({
  changePublishSubdomain: vi.fn(),
  PublishError: MockPublishError,
  PUBLISH_HOST: 'pagespace.site',
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  isPrincipalDriveOwnerOrAdmin: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { getPlan } from '@/lib/subscription/plans';
import { changePublishSubdomain } from '@/lib/canvas/publish-page';
import { authenticateRequestWithOptions, isAuthError, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// Chainable db.select() mock: supports the innerJoin()+limit() shape used by
// canChooseSubdomain() and the plain where()+limit() shape used by GET.
function mockSelectChain(result: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(result)),
  };
  return chain;
}

describe('PATCH /api/drives/[driveId]/subdomain', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain: 'new-name' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));

    expect(response.status).toBe(401);
  });

  it('returns 403 when the principal is not owner/admin', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain: 'new-name' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(changePublishSubdomain).not.toHaveBeenCalled();
    expect(body.error).toBe('Only drive owners and admins can change the subdomain');
  });

  it('returns 403 when the tier does not allow choosing a subdomain', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{ tier: 'free' }]) as never);
    vi.mocked(getPlan).mockReturnValue({ limits: { canChooseSubdomain: false } } as ReturnType<typeof getPlan>);

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain: 'new-name' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));

    expect(response.status).toBe(403);
    expect(changePublishSubdomain).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid subdomain without calling the service', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{ tier: 'pro' }]) as never);
    vi.mocked(getPlan).mockReturnValue({ limits: { canChooseSubdomain: true } } as ReturnType<typeof getPlan>);

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain: '' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));

    expect(response.status).toBe(400);
    expect(changePublishSubdomain).not.toHaveBeenCalled();
  });

  it('persists the new subdomain via changePublishSubdomain and returns it', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{ tier: 'pro' }]) as never);
    vi.mocked(getPlan).mockReturnValue({ limits: { canChooseSubdomain: true } } as ReturnType<typeof getPlan>);
    vi.mocked(changePublishSubdomain).mockResolvedValue({ oldSubdomain: 'old-name', newSubdomain: 'new-name' });

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain: 'new-name' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(changePublishSubdomain).toHaveBeenCalledWith(mockDriveId, 'new-name', mockUserId);
    expect(body.subdomain).toBe('new-name');
    expect(body.url).toBe('https://new-name.pagespace.site');
  });

  it('maps a PublishError from the service to its status code', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectChain([{ tier: 'pro' }]) as never);
    vi.mocked(getPlan).mockReturnValue({ limits: { canChooseSubdomain: true } } as ReturnType<typeof getPlan>);
    vi.mocked(changePublishSubdomain).mockRejectedValue(new MockPublishError('Subdomain "new-name" is already taken', 409));

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain: 'new-name' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Subdomain "new-name" is already taken');
  });
});

describe('GET /api/drives/[driveId]/subdomain', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
  });

  it('returns the current subdomain and change eligibility', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectChain([{ publishSubdomain: 'current-name' }]) as never)
      .mockReturnValueOnce(mockSelectChain([{ tier: 'pro' }]) as never);
    vi.mocked(getPlan).mockReturnValue({ limits: { canChooseSubdomain: true } } as ReturnType<typeof getPlan>);

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`);
    const response = await GET(request, createContext(mockDriveId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      subdomain: 'current-name',
      canChange: true,
      publishHost: 'pagespace.site',
    });
  });

  it('returns 403 when the principal is not owner/admin', async () => {
    vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(false);

    const request = new Request(`https://example.com/api/drives/${mockDriveId}/subdomain`);
    const response = await GET(request, createContext(mockDriveId));

    expect(response.status).toBe(403);
  });
});

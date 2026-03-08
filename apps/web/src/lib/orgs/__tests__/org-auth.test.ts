import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { withOrgAuth, withOrgAdminAuth, withOrgOwnerAuth, type OrgRouteContext } from '../org-auth';

vi.mock('../../auth/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('../../auth/csrf-validation', () => ({
  validateCSRF: vi.fn(),
}));

vi.mock('../guardrails', () => ({
  isOrgMember: vi.fn(),
  isOrgAdmin: vi.fn(),
  isOrgOwner: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  logSecurityEvent: vi.fn(),
  securityAudit: {
    logAccessDenied: vi.fn().mockReturnValue(Promise.resolve()),
  },
}));

import { verifyAuth } from '../../auth/auth';
import { validateCSRF } from '../../auth/csrf-validation';
import { isOrgMember, isOrgAdmin, isOrgOwner } from '../guardrails';

const mockVerifyAuth = vi.mocked(verifyAuth);
const mockValidateCSRF = vi.mocked(validateCSRF);
const mockIsOrgMember = vi.mocked(isOrgMember);
const mockIsOrgAdmin = vi.mocked(isOrgAdmin);
const mockIsOrgOwner = vi.mocked(isOrgOwner);

function makeRequest(method = 'GET'): Request {
  return new Request('http://localhost/api/orgs/org-1', { method });
}

function makeContext(orgId = 'org-1'): OrgRouteContext {
  return { params: Promise.resolve({ orgId }) };
}

const mockUser = {
  id: 'user-1',
  role: 'user' as const,
  tokenVersion: 1,
  adminRoleVersion: 1,
  authTransport: 'cookie' as const,
};

const mockHandler = vi.fn().mockResolvedValue(Response.json({ ok: true }));

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(null);
});

describe('withOrgAuth', () => {
  it('should return 401 when not authenticated', async () => {
    mockVerifyAuth.mockResolvedValue(null);
    const handler = withOrgAuth(mockHandler);
    const response = await handler(makeRequest(), makeContext());

    expect(response.status).toBe(401);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should return 403 when user is not an org member', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgMember.mockResolvedValue(false);
    const handler = withOrgAuth(mockHandler);
    const response = await handler(makeRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should call handler when user is an org member', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgMember.mockResolvedValue(true);
    const handler = withOrgAuth(mockHandler);
    await handler(makeRequest(), makeContext());

    expect(mockHandler).toHaveBeenCalledWith(mockUser, expect.any(Request), expect.any(Object), 'org-1');
  });

  it('should validate CSRF for POST requests with cookie auth', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgMember.mockResolvedValue(true);
    const csrfError = NextResponse.json({ error: 'CSRF' }, { status: 403 });
    mockValidateCSRF.mockResolvedValue(csrfError);

    const handler = withOrgAuth(mockHandler);
    const response = await handler(makeRequest('POST'), makeContext());

    expect(response.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should skip CSRF for GET requests', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgMember.mockResolvedValue(true);
    const handler = withOrgAuth(mockHandler);
    await handler(makeRequest('GET'), makeContext());

    expect(mockValidateCSRF).not.toHaveBeenCalled();
    expect(mockHandler).toHaveBeenCalled();
  });

  it('should skip CSRF for bearer token auth', async () => {
    const bearerUser = { ...mockUser, authTransport: 'bearer' as const };
    mockVerifyAuth.mockResolvedValue(bearerUser);
    mockIsOrgMember.mockResolvedValue(true);
    const handler = withOrgAuth(mockHandler);
    await handler(makeRequest('POST'), makeContext());

    expect(mockValidateCSRF).not.toHaveBeenCalled();
    expect(mockHandler).toHaveBeenCalled();
  });
});

describe('withOrgAdminAuth', () => {
  it('should return 403 when user is not an admin', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgAdmin.mockResolvedValue(false);
    const handler = withOrgAdminAuth(mockHandler);
    const response = await handler(makeRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should call handler when user is an admin', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgAdmin.mockResolvedValue(true);
    const handler = withOrgAdminAuth(mockHandler);
    await handler(makeRequest(), makeContext());

    expect(mockHandler).toHaveBeenCalled();
  });

  it('should validate CSRF for state-changing requests', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    const csrfError = NextResponse.json({ error: 'CSRF' }, { status: 403 });
    mockValidateCSRF.mockResolvedValue(csrfError);

    const handler = withOrgAdminAuth(mockHandler);
    const response = await handler(makeRequest('PUT'), makeContext());

    expect(response.status).toBe(403);
    expect(mockIsOrgAdmin).not.toHaveBeenCalled();
  });
});

describe('withOrgOwnerAuth', () => {
  it('should return 403 when user is not the owner', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgOwner.mockResolvedValue(false);
    const handler = withOrgOwnerAuth(mockHandler);
    const response = await handler(makeRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should call handler when user is the owner', async () => {
    mockVerifyAuth.mockResolvedValue(mockUser);
    mockIsOrgOwner.mockResolvedValue(true);
    const handler = withOrgOwnerAuth(mockHandler);
    await handler(makeRequest(), makeContext());

    expect(mockHandler).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * POST /api/integrations/providers admin gate.
 *
 * verifyAdminAuth returns `VerifiedUser | NextResponse`. A NextResponse is
 * truthy, so a bare `if (!adminAuth)` check never fires: a signed-in
 * non-admin (or a CSRF-failing cookie session) would pass the gate and create
 * a global custom integration provider. The route must use the
 * isAdminAuthError type guard and return the denial response, exactly like
 * the sibling install route.
 */

const mockVerifyAdminAuth = vi.fn();
const mockCreateProvider = vi.fn();

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    // A signed-in, CSRF-valid non-admin session for the first-layer check.
    authenticateRequestWithOptions: vi.fn(async () => ({
      userId: 'user-non-admin',
      tokenVersion: 1,
      authType: 'session',
    })),
    isAuthError: (result: { error?: unknown }) => 'error' in result,
    verifyAdminAuth: (...args: unknown[]) => mockVerifyAdminAuth(...args),
  };
});

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/integrations/repositories/provider-repository', () => ({
  listEnabledProviders: vi.fn(async () => []),
  createProvider: (...args: unknown[]) => mockCreateProvider(...args),
  seedBuiltinProviders: vi.fn(async () => []),
  refreshBuiltinProviders: vi.fn(async () => 0),
}));
vi.mock('@pagespace/lib/integrations/providers/builtin-providers', () => ({
  builtinProviderList: [],
  isBuiltinProvider: () => false,
}));
vi.mock('@/lib/integrations/connect-metadata', () => ({
  sanitizeConnectMetadata: () => ({ oauthScopeDescriptions: undefined, connectNotes: undefined }),
}));

const VALID_BODY = {
  slug: 'evil-provider',
  name: 'Evil Provider',
  providerType: 'custom',
  config: {},
};

function postRequest(): Request {
  return new Request('https://pagespace.ai/api/integrations/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  });
}

describe('POST /api/integrations/providers admin gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateProvider.mockResolvedValue({ id: 'prov-1', slug: VALID_BODY.slug });
  });

  it('returns 403 and creates no row when a signed-in non-admin posts a provider', async () => {
    const denial = NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    mockVerifyAdminAuth.mockResolvedValue(denial);

    const { POST } = await import('../route');
    const response = await POST(postRequest());

    expect(response.status).toBe(403);
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });

  it('returns the CSRF-failure response itself when verifyAdminAuth denies on CSRF', async () => {
    const csrfDenial = NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 });
    mockVerifyAdminAuth.mockResolvedValue(csrfDenial);

    const { POST } = await import('../route');
    const response = await POST(postRequest());

    expect(response).toBe(csrfDenial);
    expect(await response.json()).toEqual({ error: 'CSRF validation failed' });
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });

  it('creates the provider when verifyAdminAuth returns an admin user (control)', async () => {
    mockVerifyAdminAuth.mockResolvedValue({ id: 'user-admin', role: 'admin' });

    const { POST } = await import('../route');
    const response = await POST(postRequest());

    expect(response.status).toBe(201);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Global Prompt service-auth gate (finding M4).
 *
 * GET supports two auth paths:
 *  - service-to-service via `x-service-secret` matched against SERVICE_API_SECRET,
 *    which on success trusts an arbitrary `x-service-user-id` and returns that
 *    user's COMPLETE prompt/context window.
 *  - interactive admins via withAdminAuth.
 *
 * The service secret is an unhashed shared secret, so the comparison MUST be
 * timing-safe (secureCompare) and MUST fail closed when SERVICE_API_SECRET is
 * unset or empty. The `x-service-user-id` impersonation path must only be
 * reachable AFTER the secret comparison passes.
 *
 * These tests drive the auth gate only; the heavy prompt-building pipeline is
 * stubbed so import succeeds without executing it.
 */

// withAdminAuth: observable sentinel for the non-service (interactive) path.
const mockWithAdminAuth = vi.fn(
  (_handler: unknown) => async () => new Response('admin-path', { status: 299 })
);
vi.mock('@/lib/auth/auth', () => ({
  withAdminAuth: (handler: unknown) => mockWithAdminAuth(handler),
}));

// Stub every heavy import so loading the route module never executes the
// prompt-building pipeline or touches a real DB/connection.
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn(), asc: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {}, pages: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ driveMembers: {} }));
vi.mock('@pagespace/lib/monitoring/ai-context-calculator', () => ({
  estimateSystemPromptTokens: () => 0,
}));
vi.mock('@/lib/ai/core/complete-request-builder', () => ({ buildCompleteRequest: vi.fn() }));
vi.mock('@/lib/ai/core/schema-introspection', () => ({
  extractToolSchemas: vi.fn(() => []),
  calculateTotalToolTokens: vi.fn(() => 0),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({ pageSpaceTools: {} }));
vi.mock('@/lib/ai/core/system-prompt', () => ({ buildSystemPrompt: vi.fn(() => '') }));
vi.mock('@/lib/ai/core/agent-awareness', () => ({ buildAgentAwarenessPrompt: vi.fn(async () => '') }));
vi.mock('@/lib/ai/core/page-tree-context', () => ({
  getPageTreeContext: vi.fn(async () => ''),
  getDriveListSummary: vi.fn(async () => ''),
}));
vi.mock('@/lib/ai/core/inline-instructions', () => ({
  buildInlineInstructions: vi.fn(() => ''),
  buildGlobalAssistantInstructions: vi.fn(() => ''),
}));
vi.mock('@/lib/ai/core/stub-tools', () => ({ CORE_TOOL_NAMES: new Set<string>() }));

const SERVICE_SECRET = 'svc-secret-canonical-value';
const URL_BASE = 'https://pagespace.ai/api/admin/global-prompt';

function getRequest(headers: Record<string, string> = {}): Request {
  return new Request(URL_BASE, { method: 'GET', headers });
}

describe('global-prompt GET service-auth gate (M4)', () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedSecret = process.env.SERVICE_API_SECRET;
    process.env.SERVICE_API_SECRET = SERVICE_SECRET;
  });

  afterEach(() => {
    if (savedSecret !== undefined) process.env.SERVICE_API_SECRET = savedSecret;
    else delete process.env.SERVICE_API_SECRET;
  });

  it('returns 403 when x-service-secret does not match', async () => {
    const { GET } = await import('../route');
    const res = await GET(getRequest({ 'x-service-secret': 'wrong-secret' }));
    expect(res.status).toBe(403);
    expect(mockWithAdminAuth).not.toHaveBeenCalled();
  });

  it('ignores x-service-user-id when the secret is wrong (impersonation path gated behind compare)', async () => {
    const { GET } = await import('../route');
    const res = await GET(
      getRequest({ 'x-service-secret': 'wrong-secret', 'x-service-user-id': 'victim-user-id' })
    );
    // Must be 403 (rejected), NOT 400 (missing user) or 200 (served) — proving the
    // user-id path is never consulted unless the secret comparison passes.
    expect(res.status).toBe(403);
  });

  it('fails closed with 403 when SERVICE_API_SECRET is unset, even if a header is provided', async () => {
    delete process.env.SERVICE_API_SECRET;
    const { GET } = await import('../route');
    const res = await GET(
      getRequest({ 'x-service-secret': 'anything', 'x-service-user-id': 'u1' })
    );
    expect(res.status).toBe(403);
  });

  it('fails closed with 403 when SERVICE_API_SECRET is empty and an empty secret header is sent', async () => {
    // secureCompare('', '') is structurally true; the explicit empty-secret guard
    // is what prevents an empty env var from authenticating an empty header.
    process.env.SERVICE_API_SECRET = '';
    const { GET } = await import('../route');
    const res = await GET(
      getRequest({ 'x-service-secret': '', 'x-service-user-id': 'u1' })
    );
    expect(res.status).toBe(403);
  });

  it('reaches the user-context check only after the secret matches (400 on missing user id)', async () => {
    const { GET } = await import('../route');
    const res = await GET(getRequest({ 'x-service-secret': SERVICE_SECRET }));
    // Past the 403 gate (compare passed) but no x-service-user-id -> 400.
    expect(res.status).toBe(400);
    expect(mockWithAdminAuth).not.toHaveBeenCalled();
  });

  it('falls through to withAdminAuth when no x-service-secret header is present', async () => {
    const { GET } = await import('../route');
    const res = await GET(getRequest({}));
    expect(mockWithAdminAuth).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(299);
  });
});

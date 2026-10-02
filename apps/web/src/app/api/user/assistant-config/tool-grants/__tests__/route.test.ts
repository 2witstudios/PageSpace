import { describe, it, expect, beforeEach, vi } from 'vitest';

const listAllGrants = vi.hoisted(() => vi.fn());
const revokeGrant = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/repositories/tool-approval-repository', () => ({
  toolApprovalRepository: { listAllGrants, revokeGrant },
}));

import { GET, DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: 'user_1', tokenVersion: 0, tokenType: 'session' as const, sessionId: 's', role: 'user' as const, adminRoleVersion: 0,
  });
};

describe('GET /api/user/assistant-config/tool-grants', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAuth(); });

  it('lists the CALLER\'s grants only', async () => {
    const createdAt = new Date('2026-09-01T00:00:00Z');
    listAllGrants.mockResolvedValue([{ id: 'g1', toolName: 'trash_page', conversationId: null, createdAt }]);
    const response = await GET(new Request('http://localhost/api/user/assistant-config/tool-grants'));
    expect(listAllGrants).toHaveBeenCalledWith('user_1');
    expect(await response.json()).toEqual({ grants: [{ id: 'g1', toolName: 'trash_page', conversationId: null, createdAt: createdAt.toISOString() }] });
  });

  it('rejects an unauthenticated caller', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: new Response('nope', { status: 401 }) } as never);
    const response = await GET(new Request('http://localhost/api/user/assistant-config/tool-grants'));
    expect(response.status).toBe(401);
    expect(listAllGrants).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/user/assistant-config/tool-grants', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAuth(); });

  const del = (body: unknown) =>
    DELETE(new Request('http://localhost/api/user/assistant-config/tool-grants', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

  it('revokes by id, scoped to the caller', async () => {
    revokeGrant.mockResolvedValue(true);
    const response = await del({ grantId: 'g1' });
    expect(revokeGrant).toHaveBeenCalledWith({ userId: 'user_1', grantId: 'g1' });
    expect(await response.json()).toEqual({ revoked: true });
  });

  it('answers 404 when nothing was revoked (unknown id, or someone else\'s grant)', async () => {
    revokeGrant.mockResolvedValue(false);
    expect((await del({ grantId: 'not-mine' })).status).toBe(404);
  });

  it('answers 400 without a grantId', async () => {
    expect((await del({})).status).toBe(400);
    expect(revokeGrant).not.toHaveBeenCalled();
  });
});

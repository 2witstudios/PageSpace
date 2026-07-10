/**
 * DELETE /api/account/oauth-grants/[grantId] (Phase 8 task
 * cg0aqe6bu21qg2tj7lgswf38): session-authenticated, step-up gated revoke of
 * a single OAuth grant by row id, scoped to the authenticated user.
 *
 * Zero trust: a grant that doesn't exist and a grant that exists but belongs
 * to someone else must be indistinguishable from the response — the
 * ownership-check test below is written FIRST, before the happy path, per
 * this stage's TDD requirement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/repositories/oauth-repository', () => ({
  findOAuthGrantById: vi.fn(),
  revokeOAuthGrantFamily: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  consumeStepUpGrant: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { DELETE } from '../route';
import { findOAuthGrantById, revokeOAuthGrantFamily } from '@/lib/repositories/oauth-repository';
import { consumeStepUpGrant } from '@pagespace/lib/auth/step-up-service';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const USER_A = 'user-a';
const createContext = (grantId = 'grant-1') => ({ params: Promise.resolve({ grantId }) });

function makeRequest(body: Record<string, unknown> = { stepUpToken: 'ps_stepup_test' }): NextRequest {
  return new NextRequest('http://localhost/api/account/oauth-grants/grant-1', {
    method: 'DELETE',
    headers: { Cookie: 'ps_session=valid-token', 'X-CSRF-Token': 'valid-csrf-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('DELETE /api/account/oauth-grants/[grantId]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: USER_A,
      role: 'user',
      tokenVersion: 0,
      tokenType: 'session',
      sessionId: 'session-1',
    } as never);
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(consumeStepUpGrant).mockResolvedValue({ ok: true } as never);
    vi.mocked(revokeOAuthGrantFamily).mockResolvedValue(undefined);
  });

  describe('ownership check (no oracle)', () => {
    it('returns the exact same 404 shape whether the grant does not exist or belongs to another user', async () => {
      vi.mocked(findOAuthGrantById).mockResolvedValueOnce(null);
      const notFoundResponse = await DELETE(makeRequest(), createContext());
      const notFoundBody = await notFoundResponse.json();

      vi.mocked(findOAuthGrantById).mockResolvedValueOnce({ id: 'grant-1', userId: 'user-b', familyId: 'family-1' });
      const foreignResponse = await DELETE(makeRequest(), createContext());
      const foreignBody = await foreignResponse.json();

      expect(notFoundResponse.status).toBe(foreignResponse.status);
      expect(notFoundBody).toEqual(foreignBody);
      expect(revokeOAuthGrantFamily).not.toHaveBeenCalled();
    });

    it('never revokes a grant owned by a different user, even with a valid step-up grant', async () => {
      vi.mocked(findOAuthGrantById).mockResolvedValue({ id: 'grant-1', userId: 'user-b', familyId: 'family-1' });

      const response = await DELETE(makeRequest(), createContext());

      expect(response.status).toBe(404);
      expect(revokeOAuthGrantFamily).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('revokes the grant family when the row belongs to the requesting user', async () => {
      vi.mocked(findOAuthGrantById).mockResolvedValue({ id: 'grant-1', userId: USER_A, familyId: 'family-1' });

      const response = await DELETE(makeRequest(), createContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toMatch(/revoked/i);
      expect(revokeOAuthGrantFamily).toHaveBeenCalledWith('family-1', expect.any(Date));
    });
  });

  describe('step-up gate', () => {
    it('returns 401 when stepUpToken is missing, never reaching the repository', async () => {
      const response = await DELETE(makeRequest({}), createContext());

      expect(response.status).toBe(401);
      expect(findOAuthGrantById).not.toHaveBeenCalled();
      expect(revokeOAuthGrantFamily).not.toHaveBeenCalled();
    });

    it('returns 401 when the step-up grant fails to consume, never reaching the repository', async () => {
      vi.mocked(consumeStepUpGrant).mockResolvedValue({ ok: false, error: { code: 'STEP_UP_REQUIRED' } } as never);

      const response = await DELETE(makeRequest(), createContext());

      expect(response.status).toBe(401);
      expect(findOAuthGrantById).not.toHaveBeenCalled();
      expect(revokeOAuthGrantFamily).not.toHaveBeenCalled();
    });

    it('reports an empty-string stepUpToken with the exact same error shape as a missing one', async () => {
      const missingResponse = await DELETE(makeRequest({}), createContext());
      const emptyResponse = await DELETE(makeRequest({ stepUpToken: '' }), createContext());

      expect(emptyResponse.status).toBe(missingResponse.status);
      expect(await emptyResponse.json()).toEqual(await missingResponse.json());
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('consumes the step-up grant bound to this exact grantId', async () => {
      vi.mocked(findOAuthGrantById).mockResolvedValue({ id: 'grant-1', userId: USER_A, familyId: 'family-1' });

      await DELETE(makeRequest({ stepUpToken: 'ps_stepup_test' }), createContext('grant-1'));

      expect(consumeStepUpGrant).toHaveBeenCalledWith({
        userId: USER_A,
        token: 'ps_stepup_test',
        actionBinding: { op: 'revoke_oauth_grant', grantId: 'grant-1' },
      });
    });
  });

  it('returns 500 when the repository throws', async () => {
    vi.mocked(findOAuthGrantById).mockRejectedValue(new Error('DB error'));

    const response = await DELETE(makeRequest(), createContext());
    expect(response.status).toBe(500);
  });
});

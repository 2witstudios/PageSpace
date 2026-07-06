/**
 * Contract tests for the shared step-up gate (`requireStepUpGrant`) used by
 * both the mcp-tokens mint (POST) and update (PATCH) routes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  consumeStepUpGrant: vi.fn(),
}));

import { requireStepUpGrant } from '../step-up-gate';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { consumeStepUpGrant } from '@pagespace/lib/auth/step-up-service';

const req = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'POST' });

describe('requireStepUpGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a 401 step_up_required response and audits with missingReason when stepUpToken is absent, never calling consumeStepUpGrant', async () => {
    const result = await requireStepUpGrant({
      req,
      userId: 'user-1',
      stepUpToken: undefined,
      actionBinding: { op: 'mint', name: 'Token' },
      missingReason: 'mcp_token_mint_missing_step_up',
      invalidReason: 'mcp_token_mint_step_up_invalid',
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    expect(await result?.json()).toEqual({ error: 'step_up_required' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ eventType: 'authz.access.denied', userId: 'user-1', details: { reason: 'mcp_token_mint_missing_step_up' } }),
    );
  });

  it('treats an empty-string stepUpToken identically to a missing one — no validation oracle', async () => {
    const result = await requireStepUpGrant({
      req,
      userId: 'user-1',
      stepUpToken: '',
      actionBinding: { op: 'mint', name: 'Token' },
      missingReason: 'mcp_token_mint_missing_step_up',
      invalidReason: 'mcp_token_mint_step_up_invalid',
    });

    expect(result?.status).toBe(401);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('returns a 401 step_up_required response and audits with invalidReason when the grant fails to consume', async () => {
    vi.mocked(consumeStepUpGrant).mockResolvedValue({ ok: false, error: { code: 'STEP_UP_REQUIRED' } } as never);

    const result = await requireStepUpGrant({
      req,
      userId: 'user-1',
      stepUpToken: 'ps_stepup_bad',
      actionBinding: { op: 'update', name: 'token-123' },
      missingReason: 'mcp_token_update_missing_step_up',
      invalidReason: 'mcp_token_update_step_up_invalid',
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    expect(await result?.json()).toEqual({ error: 'step_up_required' });
    expect(auditRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ eventType: 'authz.access.denied', userId: 'user-1', details: { reason: 'mcp_token_update_step_up_invalid' } }),
    );
  });

  it('returns null (proceed) once the grant is consumed, passing the given actionBinding through untouched', async () => {
    vi.mocked(consumeStepUpGrant).mockResolvedValue({ ok: true });

    const actionBinding = { op: 'mint', name: 'Token', driveScopes: '[]' };
    const result = await requireStepUpGrant({
      req,
      userId: 'user-1',
      stepUpToken: 'ps_stepup_good',
      actionBinding,
      missingReason: 'mcp_token_mint_missing_step_up',
      invalidReason: 'mcp_token_mint_step_up_invalid',
    });

    expect(result).toBeNull();
    expect(consumeStepUpGrant).toHaveBeenCalledWith({ userId: 'user-1', token: 'ps_stepup_good', actionBinding });
    expect(auditRequest).not.toHaveBeenCalled();
  });
});

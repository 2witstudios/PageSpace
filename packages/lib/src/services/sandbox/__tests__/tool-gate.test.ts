import { describe, it, expect } from 'vitest';
import { gateSandboxToolCall, type SandboxToolGateDeps } from '../tool-gate';

// A fully-permissive set of injected deps; each test overrides the one boundary
// it exercises so a single denial is never masked by another check.
function allowDeps(overrides: Partial<SandboxToolGateDeps> = {}): SandboxToolGateDeps {
  return {
    isEnabled: () => true,
    authorize: async () => ({ ok: true }),
    checkQuota: async () => ({ allowed: true }),
    ...overrides,
  };
}

const input = {
  userId: 'u1',
  driveId: 'd1',
  tenantId: 't1',
  tier: 'pro' as const,
};

describe('gateSandboxToolCall', () => {
  it('given the kill-switch off, should deny before any authz or quota IO', async () => {
    let authorized = false;
    let quotaChecked = false;
    const result = await gateSandboxToolCall({
      ...input,
      deps: allowDeps({
        isEnabled: () => false,
        authorize: async () => {
          authorized = true;
          return { ok: true };
        },
        checkQuota: async () => {
          quotaChecked = true;
          return { allowed: true };
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off', error: expect.any(String) });
    expect(authorized).toBe(false);
    expect(quotaChecked).toBe(false);
  });

  it('given an actor without drive access, should deny and not check quota', async () => {
    let quotaChecked = false;
    const result = await gateSandboxToolCall({
      ...input,
      deps: allowDeps({
        authorize: async () => ({ ok: false, reason: 'no_drive_access' }),
        checkQuota: async () => {
          quotaChecked = true;
          return { allowed: true };
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'no_drive_access' });
    expect(quotaChecked).toBe(false);
  });

  it('given an authorized actor at the concurrency ceiling, should deny with concurrency_limit', async () => {
    const result = await gateSandboxToolCall({
      ...input,
      deps: allowDeps({
        checkQuota: async () => ({ allowed: false, reason: 'concurrency_limit' }),
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'concurrency_limit' });
  });

  it('given kill-switch on, authorized, and within quota, should allow', async () => {
    const result = await gateSandboxToolCall({ ...input, deps: allowDeps() });
    expect(result).toEqual({ ok: true });
  });

  it('given an authorize dependency that throws, should fail closed to a denial', async () => {
    const result = await gateSandboxToolCall({
      ...input,
      deps: allowDeps({
        authorize: async () => {
          throw new Error('db down');
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'error' });
  });

  it('given no driveId and kill switch on, authorized, not rate limited, should allow', async () => {
    const result = await gateSandboxToolCall({
      userId: 'u1',
      tier: 'pro',
      deps: allowDeps(),
    });
    expect(result).toEqual({ ok: true });
  });

  it('given no driveId and kill switch off, should deny with kill_switch_off', async () => {
    const result = await gateSandboxToolCall({
      userId: 'u1',
      tier: 'pro',
      deps: allowDeps({ isEnabled: () => false }),
    });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off', error: expect.any(String) });
  });

  it('given an agent-origin run, should pass requestOrigin and agentPageId through to authorize', async () => {
    let seen: { requestOrigin?: string; agentPageId?: string } = {};
    await gateSandboxToolCall({
      ...input,
      requestOrigin: 'agent',
      agentPageId: 'agent-page-1',
      deps: allowDeps({
        authorize: async ({ requestOrigin, agentPageId }) => {
          seen = { requestOrigin, agentPageId };
          return { ok: true };
        },
      }),
    });
    expect(seen).toEqual({ requestOrigin: 'agent', agentPageId: 'agent-page-1' });
  });
});

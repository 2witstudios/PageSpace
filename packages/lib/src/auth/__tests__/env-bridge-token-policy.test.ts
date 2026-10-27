import { describe, it, expect } from 'vitest';
import { getEnvBridgeTokenPolicy, ENV_BRIDGE_SCOPE, ENV_BRIDGE_TOKEN_TTL_MS, WS_TOKEN_SCOPE, WS_TOKEN_TTL_MS } from '../token-lifecycle-policy';

describe('getEnvBridgeTokenPolicy — the socket token a machine earns by proving key possession', () => {
  it('should be a user-scoped (non-service) token carrying ONLY the env:bridge scope and the env + enrollment it is for', () => {
    const policy = getEnvBridgeTokenPolicy({ envId: 'env_1', enrollmentId: 'enr_1' });
    expect(policy.type).toBe('mcp');
    expect(policy.scopes).toEqual([ENV_BRIDGE_SCOPE]);
    expect(policy.claims).toEqual({ envId: 'env_1', enrollmentId: 'enr_1' });
  });

  it('should be short-lived: minutes, not the ws-token\'s days — a leaked bridge token is a bounded capability', () => {
    const policy = getEnvBridgeTokenPolicy({ envId: 'env_1', enrollmentId: 'enr_1' });
    expect(policy.ttlMs).toBe(ENV_BRIDGE_TOKEN_TTL_MS);
    expect(policy.ttlMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(policy.ttlMs).toBeLessThan(WS_TOKEN_TTL_MS);
  });

  it('should use a scope no other route accepts (distinct from the desktop ws scope and the mcp wildcard)', () => {
    expect(ENV_BRIDGE_SCOPE).toBe('env:bridge');
    expect(ENV_BRIDGE_SCOPE).not.toBe(WS_TOKEN_SCOPE);
    expect(ENV_BRIDGE_SCOPE.startsWith('mcp:')).toBe(false);
  });
});

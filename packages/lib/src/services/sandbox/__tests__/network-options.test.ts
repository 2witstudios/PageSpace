import { describe, it, expect } from 'vitest';
import { resolveSandboxNetworkOptions } from '../network-options';
import { SANDBOX_RESOURCE_CAPS } from '../execution-policy';
import { buildSpriteNetworkPolicy } from '../egress';

describe('resolveSandboxNetworkOptions', () => {
  it('given surface: agent, should resolve OPEN egress (no longer the tight allowlist)', () => {
    const options = resolveSandboxNetworkOptions({ surface: 'agent' });
    expect(options.egressMode).toBe('open');
  });

  it('given surface: terminal, should resolve OPEN egress identically (one source of truth)', () => {
    const agent = resolveSandboxNetworkOptions({ surface: 'agent' });
    const terminal = resolveSandboxNetworkOptions({ surface: 'terminal' });
    expect(terminal.egressMode).toBe('open');
    expect(terminal.egressMode).toBe(agent.egressMode);
  });

  it('given either surface, should carry the standard resource caps', () => {
    expect(resolveSandboxNetworkOptions({ surface: 'agent' }).caps).toEqual(SANDBOX_RESOURCE_CAPS);
    expect(resolveSandboxNetworkOptions({ surface: 'terminal' }).caps).toEqual(SANDBOX_RESOURCE_CAPS);
  });

  it('given a configured egress-IP tag, should carry it on the options (dedicated attribution)', () => {
    const options = resolveSandboxNetworkOptions({ surface: 'agent', egressIpTag: 'sandbox-egress-iad' });
    expect(options.egressIpTag).toBe('sandbox-egress-iad');
  });

  it('given NO egress-IP tag, should still carry a sandbox-scoped default tag (degraded attribution)', () => {
    const options = resolveSandboxNetworkOptions({ surface: 'agent' });
    expect(typeof options.egressIpTag).toBe('string');
    expect((options.egressIpTag as string).toLowerCase()).toContain('sandbox');
  });

  it('resolved options should produce a policy whose internal surface is denied before allow-all', () => {
    const { rules } = buildSpriteNetworkPolicy(resolveSandboxNetworkOptions({ surface: 'agent' }));
    const allowAllIdx = rules.findIndex((r) => r.domain === '*' && r.action === 'allow');
    expect(rules.some((r) => r.domain === '_api.internal' && r.action === 'deny')).toBe(true);
    expect(allowAllIdx).toBeGreaterThan(0);
  });
});

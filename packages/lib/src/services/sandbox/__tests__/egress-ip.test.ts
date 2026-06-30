import { describe, it, expect } from 'vitest';
import { resolveEgressIpTag } from '../egress-ip';

describe('resolveEgressIpTag', () => {
  it('given a configured tag, should resolve it as the dedicated attribution tag', () => {
    expect(resolveEgressIpTag({ surface: 'agent', configuredTag: 'sandbox-egress-iad' })).toEqual({
      tag: 'sandbox-egress-iad',
      dedicated: true,
    });
  });

  it('given no configured tag (env unset), should fall back to a safe default and flag attribution as degraded', () => {
    const resolved = resolveEgressIpTag({ surface: 'agent', configuredTag: null });
    expect(resolved.dedicated).toBe(false);
    // The default must be sandbox-scoped — never the production pool.
    expect(resolved.tag.toLowerCase()).toContain('sandbox');
  });

  it('given an empty/whitespace tag, should treat it as unset (degraded)', () => {
    expect(resolveEgressIpTag({ surface: 'terminal', configuredTag: '   ' }).dedicated).toBe(false);
  });

  it('a configured tag is trimmed', () => {
    expect(resolveEgressIpTag({ surface: 'terminal', configuredTag: '  t1  ' })).toEqual({
      tag: 't1',
      dedicated: true,
    });
  });
});

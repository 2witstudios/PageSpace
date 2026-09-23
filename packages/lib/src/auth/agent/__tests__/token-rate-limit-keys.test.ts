/**
 * Rate-limit bucket keys for the pagespace-agent token grants (jwt-bearer and
 * its refresh_token). Pure. A per-CLIENT bucket would be one platform-wide
 * bucket every agent shares, so agents are limited per IP and per presented
 * credential instead — and the credential is keyed by its hash, never raw.
 */
import { describe, it, expect } from 'vitest';
import { hashToken } from '../../token-utils';
import {
  agentTokenIpRateLimitKey,
  agentTokenCredentialRateLimitKey,
  agentRefreshRateLimitKey,
  agentSecretRotateRateLimitKey,
  agentRateLimitAddress,
} from '../token-rate-limit-keys';

const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';

describe('agentTokenIpRateLimitKey', () => {
  it('given an IP, should key the bucket on that IP', () => {
    expect(agentTokenIpRateLimitKey('203.0.113.5')).toBe('agent-token:ip:203.0.113.5');
  });

  it('given two IPs, should give them separate buckets', () => {
    expect(agentTokenIpRateLimitKey('203.0.113.5')).not.toBe(agentTokenIpRateLimitKey('203.0.113.6'));
  });
});

describe('agentTokenCredentialRateLimitKey', () => {
  it('given a credential, should key the bucket on its SHA3-256 hash', () => {
    expect(agentTokenCredentialRateLimitKey(SECRET)).toBe(`agent-token:credential:${hashToken(SECRET)}`);
  });

  it('should never contain the raw credential (the key is persisted in the rate-limit table)', () => {
    expect(agentTokenCredentialRateLimitKey(SECRET)).not.toContain(SECRET);
  });

  it('given two credentials, should give them separate buckets', () => {
    expect(agentTokenCredentialRateLimitKey(SECRET)).not.toBe(agentTokenCredentialRateLimitKey(`${SECRET.slice(0, -1)}6`));
  });

  it('should not collide with an IP bucket', () => {
    expect(agentTokenCredentialRateLimitKey('203.0.113.5')).not.toBe(agentTokenIpRateLimitKey('203.0.113.5'));
  });
});

// Phase 2b: a refresh token rotates on every use, so a bucket keyed on the
// presented token is a fresh bucket per refresh — no bound at all. The family
// id survives rotation.
describe('agentRefreshRateLimitKey', () => {
  const RT_1 = 'ps_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const RT_2 = 'ps_rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('given two successive refresh tokens of one family, should key both on the family (one bucket for the whole refresh loop)', () => {
    expect(agentRefreshRateLimitKey({ familyId: 'fam-1', refreshToken: RT_1 }))
      .toBe(agentRefreshRateLimitKey({ familyId: 'fam-1', refreshToken: RT_2 }));
    expect(agentRefreshRateLimitKey({ familyId: 'fam-1', refreshToken: RT_1 })).toBe('agent-token:refresh-family:fam-1');
  });

  it('given two families, should give them separate buckets', () => {
    expect(agentRefreshRateLimitKey({ familyId: 'fam-1', refreshToken: RT_1 }))
      .not.toBe(agentRefreshRateLimitKey({ familyId: 'fam-2', refreshToken: RT_1 }));
  });

  it('given a token that resolves to no family (unknown or junk), should fall back to the hashed-credential bucket and never embed the raw token', () => {
    const key = agentRefreshRateLimitKey({ familyId: null, refreshToken: RT_1 });

    expect(key).toBe(agentTokenCredentialRateLimitKey(RT_1));
    expect(key).not.toContain(RT_1);
  });
});

// Phase 2b: rotation had no limit. Keyed on the agent being rotated, split by
// who is rotating, so a stolen agent token that exhausts the agent's own
// bucket cannot also lock the owner out of the recovery rotation.
describe('agentSecretRotateRateLimitKey', () => {
  it('given the agent rotating itself, should key on the agent and the self actor', () => {
    expect(agentSecretRotateRateLimitKey({ agentUserId: 'agent-1', actor: 'self' })).toBe('agent-secret-rotate:self:agent-1');
  });

  it('given the owner rotating, should use a separate bucket for the same agent', () => {
    expect(agentSecretRotateRateLimitKey({ agentUserId: 'agent-1', actor: 'owner' }))
      .not.toBe(agentSecretRotateRateLimitKey({ agentUserId: 'agent-1', actor: 'self' }));
  });

  it('given two agents, should give them separate buckets', () => {
    expect(agentSecretRotateRateLimitKey({ agentUserId: 'agent-1', actor: 'self' }))
      .not.toBe(agentSecretRotateRateLimitKey({ agentUserId: 'agent-2', actor: 'self' }));
  });
});

// Phase 2b: one host is routinely handed a whole IPv6 /64, so keying the
// agent door's per-IP buckets on the full address gives it unlimited buckets.
describe('agentRateLimitAddress', () => {
  it('given IPv4, should return it unchanged', () => {
    expect(agentRateLimitAddress('203.0.113.5')).toBe('203.0.113.5');
  });

  it('given two addresses in one IPv6 /64, should give them the same bucket', () => {
    expect(agentRateLimitAddress('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
    expect(agentRateLimitAddress('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:0db8:0001:0002::/64');
    expect(agentRateLimitAddress('2001:DB8:1:2:a:b:c:d')).toBe('2001:0db8:0001:0002::/64');
  });

  it('given addresses in different /64s, should give them different buckets', () => {
    expect(agentRateLimitAddress('2001:db8:1:2::1')).not.toBe(agentRateLimitAddress('2001:db8:1:3::1'));
  });

  it('given leading or all-zero compression, should expand correctly', () => {
    expect(agentRateLimitAddress('::1')).toBe('0000:0000:0000:0000::/64');
    expect(agentRateLimitAddress('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(agentRateLimitAddress('[2001:db8::5]')).toBe('2001:0db8:0000:0000::/64');
  });

  it('given an IPv4-mapped IPv6 address, should key on the IPv4 address', () => {
    expect(agentRateLimitAddress('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('given something unparseable, should return it unchanged', () => {
    expect(agentRateLimitAddress('unknown')).toBe('unknown');
    expect(agentRateLimitAddress('1::2::3')).toBe('1::2::3');
    expect(agentRateLimitAddress('zz::1')).toBe('zz::1');
  });

  it('should be what the token IP bucket keys on', () => {
    expect(agentTokenIpRateLimitKey('2001:db8:1:2::9')).toBe('agent-token:ip:2001:0db8:0001:0002::/64');
  });
});

/**
 * Rate-limit bucket keys for the pagespace-agent token grants (jwt-bearer and
 * its refresh_token). Pure. A per-CLIENT bucket would be one platform-wide
 * bucket every agent shares, so agents are limited per IP and per presented
 * credential instead — and the credential is keyed by its hash, never raw.
 */
import { describe, it, expect } from 'vitest';
import { hashToken } from '../../token-utils';
import { agentTokenIpRateLimitKey, agentTokenCredentialRateLimitKey } from '../token-rate-limit-keys';

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

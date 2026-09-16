import { describe, it, expect } from 'vitest';
import { buildServerMetadata, AGENT_ASSERTION_GRANT_TYPE, AGENT_CLAIM_GRANT_TYPE } from '../metadata';

describe('buildServerMetadata', () => {
  const config = { issuer: 'https://pagespace.ai' };

  it('returns exactly the RFC 8414 fields the discovery route promises', () => {
    const metadata = buildServerMetadata(config);

    expect(Object.keys(metadata).sort()).toEqual(
      [
        'agent_auth',
        'authorization_endpoint',
        'code_challenge_methods_supported',
        'device_authorization_endpoint',
        'grant_types_supported',
        'issuer',
        'response_types_supported',
        'revocation_endpoint',
        'scopes_supported',
        'token_endpoint',
        'token_endpoint_auth_methods_supported',
      ].sort(),
    );
  });

  it('derives the issuer and every endpoint from injected config, never a request Host', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.issuer).toBe('https://pagespace.ai');
    expect(metadata.authorization_endpoint).toBe('https://pagespace.ai/api/oauth/authorize');
    expect(metadata.token_endpoint).toBe('https://pagespace.ai/api/oauth/token');
    expect(metadata.device_authorization_endpoint).toBe(
      'https://pagespace.ai/api/oauth/device_authorization',
    );
    expect(metadata.revocation_endpoint).toBe('https://pagespace.ai/api/oauth/revoke');
  });

  it('strips a trailing slash from the configured issuer before deriving endpoints', () => {
    const metadata = buildServerMetadata({ issuer: 'https://pagespace.ai/' });

    expect(metadata.issuer).toBe('https://pagespace.ai');
    expect(metadata.token_endpoint).toBe('https://pagespace.ai/api/oauth/token');
  });

  it('reflects a self-hosted deployment origin unchanged (no hardcoded pagespace.ai)', () => {
    const metadata = buildServerMetadata({ issuer: 'http://onprem.internal:3000' });

    expect(metadata.issuer).toBe('http://onprem.internal:3000');
    expect(metadata.authorization_endpoint).toBe('http://onprem.internal:3000/api/oauth/authorize');
  });

  it('advertises the three original grant types first, in RFC 8628 form for device code (agent URNs follow, see below)', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.grant_types_supported.slice(0, 3)).toEqual([
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:device_code',
    ]);
  });

  it('advertises only the code response type — no implicit/token flows', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.response_types_supported).toEqual(['code']);
  });

  it('advertises S256 only for PKCE — plain must never appear', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.code_challenge_methods_supported).not.toContain('plain');
  });

  it('advertises none for token endpoint auth — public clients only, no client secrets', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('advertises the ADR 0002 scope grammar tokens', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.scopes_supported).toContain('account');
    expect(metadata.scopes_supported).toContain('offline_access');
    expect(metadata.scopes_supported).toContain('manage_keys');
    expect(metadata.scopes_supported.some((scope) => scope.startsWith('drive:'))).toBe(true);
  });

  it('is pure: identical config in, deep-equal metadata out, no shared mutable state across calls', () => {
    const first = buildServerMetadata(config);
    const second = buildServerMetadata(config);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('strips a pathological run of trailing slashes in linear time (no regex backtracking)', () => {
    const pathological = `https://pagespace.ai${'/'.repeat(200_000)}`;
    const start = performance.now();
    const metadata = buildServerMetadata({ issuer: pathological });
    const elapsedMs = performance.now() - start;

    expect(metadata.issuer).toBe('https://pagespace.ai');
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('buildServerMetadata — agent_auth (ADR 0007 Decisions 5, 12)', () => {
  const config = { issuer: 'https://pagespace.ai' };

  it('advertises the auth.md agent_auth block with every URL derived from the issuer only', () => {
    const { agent_auth } = buildServerMetadata(config);

    expect(agent_auth).toEqual({
      skill: 'https://pagespace.ai/auth.md',
      identity_endpoint: 'https://pagespace.ai/api/agent/identity',
      claim_endpoint: 'https://pagespace.ai/api/agent/claim',
      challenge_endpoint: 'https://pagespace.ai/api/agent/challenge',
      identity_types_supported: ['anonymous'],
      assertion_grant_type: AGENT_ASSERTION_GRANT_TYPE,
      claim_grant_type: AGENT_CLAIM_GRANT_TYPE,
    });
  });

  it('every URL in agent_auth is absolute and under the issuer — never a request Host', () => {
    const { agent_auth } = buildServerMetadata({ issuer: 'http://onprem.internal:3000/' });
    const urls = [agent_auth.skill, agent_auth.identity_endpoint, agent_auth.claim_endpoint, agent_auth.challenge_endpoint];
    for (const url of urls) {
      expect(url.startsWith('http://onprem.internal:3000/')).toBe(true);
      // no doubled slash after the scheme (the trailing-slash issuer was trimmed)
      expect(url.slice('http://'.length)).not.toContain('//');
    }
  });

  it('names the RFC 7523 jwt-bearer URN as the assertion grant and a pagespace URN as the claim grant', () => {
    expect(AGENT_ASSERTION_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(AGENT_CLAIM_GRANT_TYPE).toBe('urn:pagespace:agent-auth:grant-type:claim');
  });

  it('adds both grant URNs to grant_types_supported without dropping the existing three', () => {
    const { grant_types_supported } = buildServerMetadata(config);
    expect(grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:device_code',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      'urn:pagespace:agent-auth:grant-type:claim',
    ]);
  });

  it('supports only the anonymous identity type (no vendor-verifiable agent identity exists)', () => {
    expect(buildServerMetadata(config).agent_auth.identity_types_supported).toEqual(['anonymous']);
  });
});

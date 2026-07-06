import { describe, it, expect } from 'vitest';
import { buildServerMetadata } from '../metadata';

describe('buildServerMetadata', () => {
  const config = { issuer: 'https://pagespace.ai' };

  it('returns exactly the RFC 8414 fields the discovery route promises', () => {
    const metadata = buildServerMetadata(config);

    expect(Object.keys(metadata).sort()).toEqual(
      [
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

  it('advertises exactly the three grant types this phase ships, in RFC 8628 form for device code', () => {
    const metadata = buildServerMetadata(config);

    expect(metadata.grant_types_supported).toEqual([
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

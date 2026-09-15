/**
 * ADR 0005 Decision 4 — the identity_assertion IS the opaque `ps_agent_*`
 * secret, minted through the house `generateToken` and SHA3-256 hashed at rest.
 */
import { describe, it, expect } from 'vitest';
import { hashToken } from '../../token-utils';
import { AGENT_SECRET_PREFIX, mintAgentSecret, isAgentSecretShape } from '../secret';

describe('mintAgentSecret', () => {
  it('returns a secret that carries the ps_agent_ prefix and satisfies the shape guard', () => {
    const minted = mintAgentSecret();
    expect(minted.secret.startsWith(`${AGENT_SECRET_PREFIX}_`)).toBe(true);
    expect(isAgentSecretShape(minted.secret)).toBe(true);
  });

  it('returns the SHA3-256 hash of the secret (the only thing stored at rest)', () => {
    const minted = mintAgentSecret();
    expect(minted.hash).toBe(hashToken(minted.secret));
    expect(minted.hash).toHaveLength(64);
  });

  it('returns the 12-character identification prefix, matching generateToken', () => {
    const minted = mintAgentSecret();
    expect(minted.prefix).toBe(minted.secret.slice(0, 12));
    expect(minted.prefix).toBe('ps_agent_' + minted.secret.slice(9, 12));
  });

  it('never collides across calls (CSPRNG-seeded CUID2, 32 chars)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(mintAgentSecret().secret);
    expect(seen.size).toBe(50);
  });
});

describe('isAgentSecretShape', () => {
  const valid = 'ps_agent_' + 'a'.repeat(32);

  it('accepts exactly ps_agent_ + 32 lowercase alphanumerics', () => {
    expect(isAgentSecretShape(valid)).toBe(true);
    expect(isAgentSecretShape('ps_agent_' + 'abcdefghij0123456789klmnopqrstuv')).toBe(true);
  });

  it('rejects other token prefixes even at the right length', () => {
    expect(isAgentSecretShape('ps_at_' + 'a'.repeat(35))).toBe(false);
    expect(isAgentSecretShape('mcp_' + 'a'.repeat(37))).toBe(false);
    expect(isAgentSecretShape('ps_agentx' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects a body one character short or long', () => {
    expect(isAgentSecretShape('ps_agent_' + 'a'.repeat(31))).toBe(false);
    expect(isAgentSecretShape('ps_agent_' + 'a'.repeat(33))).toBe(false);
  });

  it('rejects uppercase, symbols and whitespace in the body', () => {
    expect(isAgentSecretShape('ps_agent_' + 'A'.repeat(32))).toBe(false);
    expect(isAgentSecretShape('ps_agent_' + 'a'.repeat(31) + '-')).toBe(false);
    expect(isAgentSecretShape(valid + ' ')).toBe(false);
    expect(isAgentSecretShape(' ' + valid)).toBe(false);
  });

  it('rejects the empty string and the bare prefix', () => {
    expect(isAgentSecretShape('')).toBe(false);
    expect(isAgentSecretShape('ps_agent_')).toBe(false);
  });
});

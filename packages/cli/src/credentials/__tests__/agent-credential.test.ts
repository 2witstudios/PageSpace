import { describe, expect, it } from 'vitest';
import {
  credentialSecret,
  emptyCredentialsFile,
  getHost,
  parseCredentialsFile,
  parseHostCredential,
  serializeCredentialsFile,
  serializeHostCredential,
  upsertHost,
} from '@pagespace/cli';
import type { AgentHostCredential } from '@pagespace/cli';
import { isLoginCredential } from '../serialize.js';

const AGENT: AgentHostCredential = {
  kind: 'agent',
  agentId: 'agent_1',
  secret: 'ps_agent_abcdefghijklmnopqrstuvwxyz012345',
  refreshToken: 'ps_rt_1',
  clientId: 'pagespace-agent',
  claimToken: 'ps_claim_1',
  contentKeyName: 'agent',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-11-27T00:00:00.000Z',
};

describe('agent credential (kind: "agent")', () => {
  it('round-trips through the keychain secret encoding', () => {
    expect(parseHostCredential(serializeHostCredential(AGENT))).toEqual(AGENT);
  });

  it('round-trips through the credentials file', () => {
    const file = upsertHost(emptyCredentialsFile(), 'https://pagespace.ai', AGENT);
    expect(getHost(parseCredentialsFile(serializeCredentialsFile(file)), 'https://pagespace.ai')).toEqual(AGENT);
  });

  it('allows the refresh token, claim token and content key to be absent (null)', () => {
    const bare = { ...AGENT, refreshToken: null, claimToken: null, contentKeyName: null };
    expect(parseHostCredential(serializeHostCredential(bare))).toEqual(bare);
    const withoutOptional = { kind: 'agent', agentId: AGENT.agentId, secret: AGENT.secret, clientId: AGENT.clientId, scopes: AGENT.scopes, createdAt: AGENT.createdAt };
    expect(parseHostCredential(JSON.stringify(withoutOptional))).toEqual(bare);
  });

  it('refuses an agent credential with no secret, no agent id, or a non-string refresh token', () => {
    expect(() => parseHostCredential(JSON.stringify({ ...AGENT, secret: '' }))).toThrow();
    expect(() => parseHostCredential(JSON.stringify({ ...AGENT, agentId: undefined }))).toThrow();
    expect(() => parseHostCredential(JSON.stringify({ ...AGENT, refreshToken: 42 }))).toThrow();
    expect(() => parseHostCredential(JSON.stringify({ ...AGENT, refreshToken: '' }))).toThrow();
  });

  it('is a login credential (it authenticates the agent itself), and its secret is the agent secret', () => {
    expect(isLoginCredential(AGENT)).toBe(true);
    expect(credentialSecret(AGENT)).toBe(AGENT.secret);
  });
});

/**
 * The one rule for "is this caller an agent acting with the token its own
 * jwt-bearer grant minted?" (ADR 0007 Decision 6 + Decision 14). Shared by
 * secret rotation and key minting, so the two key-management doors can never
 * disagree about which bearer token speaks for an agent.
 */
import { describe, it, expect } from 'vitest';
import { classifyCallerCredential, mayManageKeysWithCredential } from '../caller-credential';

const agentGrant = { tokenType: 'oauth' as const, hasAccountScope: true, issuance: { clientId: 'pagespace-agent', accountType: 'agent' as const } };

describe('classifyCallerCredential', () => {
  it('given a session, should be session (whoever it belongs to)', () => {
    expect(classifyCallerCredential({ tokenType: 'session', hasAccountScope: false, issuance: null })).toBe('session');
  });

  it("given an agent's account-scoped token minted for pagespace-agent, should be agent_grant_token", () => {
    expect(classifyCallerCredential(agentGrant)).toBe('agent_grant_token');
  });

  it('given the same agent token minted for ANOTHER client, should be other_token', () => {
    expect(classifyCallerCredential({ ...agentGrant, issuance: { clientId: 'pagespace-cli', accountType: 'agent' } })).toBe('other_token');
  });

  it("given a HUMAN's account-scoped token, even one minted for pagespace-agent, should be other_token", () => {
    expect(classifyCallerCredential({ ...agentGrant, issuance: { clientId: 'pagespace-agent', accountType: 'human' } })).toBe('other_token');
  });

  it('given a narrow (non-account) agent token, should be other_token', () => {
    expect(classifyCallerCredential({ ...agentGrant, hasAccountScope: false })).toBe('other_token');
  });

  it('given an oauth token whose issuance row is gone, should be other_token', () => {
    expect(classifyCallerCredential({ ...agentGrant, issuance: null })).toBe('other_token');
  });

  it('given an mcp or service credential, should be other_token', () => {
    expect(classifyCallerCredential({ tokenType: 'mcp', hasAccountScope: false, issuance: null })).toBe('other_token');
    expect(classifyCallerCredential({ tokenType: 'service', hasAccountScope: false, issuance: null })).toBe('other_token');
  });
});

describe('mayManageKeysWithCredential', () => {
  it('should admit a session and the agent grant token, and nothing else', () => {
    expect(mayManageKeysWithCredential('session')).toBe(true);
    expect(mayManageKeysWithCredential('agent_grant_token')).toBe(true);
    expect(mayManageKeysWithCredential('other_token')).toBe(false);
  });
});

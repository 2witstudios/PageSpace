import { describe, expect, it } from 'vitest';
import { isAgentOwnActiveKey } from '../agent-machine.js';
import type { AgentHostCredential, OAuthHostCredential } from '../../credentials/serialize.js';

const AGENT: AgentHostCredential = {
  kind: 'agent',
  agentId: 'a',
  secret: 'ps_agent_x',
  refreshToken: null,
  clientId: 'pagespace-agent',
  claimToken: null,
  contentKeyName: 'agent',
  scopes: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const HUMAN: OAuthHostCredential = { kind: 'oauth', refreshToken: 'ps_rt', clientId: 'pagespace-cli', scopes: [], createdAt: '2026-01-01T00:00:00.000Z' };

describe('isAgentOwnActiveKey', () => {
  it('is true only when the login is an agent and the active key is the one it minted', () => {
    expect(isAgentOwnActiveKey(AGENT, 'agent')).toBe(true);
  });

  it('is false for a human login, a different active key, no active key, or an agent with no key', () => {
    expect(isAgentOwnActiveKey(HUMAN, 'agent')).toBe(false);
    expect(isAgentOwnActiveKey(AGENT, 'ci')).toBe(false);
    expect(isAgentOwnActiveKey(AGENT, null)).toBe(false);
    expect(isAgentOwnActiveKey({ ...AGENT, contentKeyName: null }, 'agent')).toBe(false);
    expect(isAgentOwnActiveKey(null, 'agent')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { agentSecretActor } from '../secret-authority';

describe('agentSecretActor', () => {
  it('given the agent itself, should be self', () => {
    expect(agentSecretActor({ callerId: 'a', agentUserId: 'a', identity: { ownerUserId: null } })).toBe('self');
  });

  it("given the agent's owner, should be owner", () => {
    expect(agentSecretActor({ callerId: 'h', agentUserId: 'a', identity: { ownerUserId: 'h' } })).toBe('owner');
  });

  it('given someone else, should refuse', () => {
    expect(agentSecretActor({ callerId: 'x', agentUserId: 'a', identity: { ownerUserId: 'h' } })).toBeNull();
  });

  it('given an unclaimed agent and a different caller, should refuse', () => {
    expect(agentSecretActor({ callerId: 'x', agentUserId: 'a', identity: { ownerUserId: null } })).toBeNull();
  });

  it('given an id with no agent identity, should refuse even for the caller itself', () => {
    expect(agentSecretActor({ callerId: 'h', agentUserId: 'h', identity: null })).toBeNull();
  });
});

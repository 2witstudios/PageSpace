/**
 * Who may rotate an agent's secret, and over which credential (ADR 0007
 * Decision 14). Rotation is a key-management action: whoever holds the new
 * secret IS the agent. So the owner path is browser-session only (a narrowly
 * scoped OAuth grant an owner handed to some other client must not be able to
 * take over their agent), and the agent itself may use its own ps_at_ only
 * when that token carries the `account` scope — what the jwt-bearer grant
 * issues. Every refusal is the same null → the same 404.
 */
import { describe, it, expect } from 'vitest';
import { agentSecretActor } from '../secret-authority';

const session = (id: string) => ({ id, credential: 'session' as const });
const accountToken = (id: string) => ({ id, credential: 'oauth_account' as const });
const narrowToken = (id: string) => ({ id, credential: 'oauth_narrow' as const });
const claimed = { ownerUserId: 'h' };
const unclaimed = { ownerUserId: null };

describe('agentSecretActor', () => {
  describe('given the agent itself', () => {
    it('with a browser session, should be self', () => {
      expect(agentSecretActor({ caller: session('a'), agentUserId: 'a', identity: unclaimed })).toBe('self');
    });

    it('with its own account-scoped access token, should be self', () => {
      expect(agentSecretActor({ caller: accountToken('a'), agentUserId: 'a', identity: unclaimed })).toBe('self');
    });

    it('with a narrowly scoped (non-account) access token, should refuse', () => {
      expect(agentSecretActor({ caller: narrowToken('a'), agentUserId: 'a', identity: unclaimed })).toBeNull();
    });
  });

  describe("given the agent's owner", () => {
    it('with a browser session, should be owner', () => {
      expect(agentSecretActor({ caller: session('h'), agentUserId: 'a', identity: claimed })).toBe('owner');
    });

    it('with ANY OAuth access token — even account-scoped — should refuse (key management is session-only for owners)', () => {
      expect(agentSecretActor({ caller: accountToken('h'), agentUserId: 'a', identity: claimed })).toBeNull();
      expect(agentSecretActor({ caller: narrowToken('h'), agentUserId: 'a', identity: claimed })).toBeNull();
    });
  });

  it('given someone else, should refuse', () => {
    expect(agentSecretActor({ caller: session('x'), agentUserId: 'a', identity: claimed })).toBeNull();
  });

  it('given an unclaimed agent and a different caller, should refuse', () => {
    expect(agentSecretActor({ caller: session('x'), agentUserId: 'a', identity: unclaimed })).toBeNull();
  });

  it('given an id with no agent identity, should refuse even for the caller itself', () => {
    expect(agentSecretActor({ caller: session('h'), agentUserId: 'h', identity: null })).toBeNull();
  });
});

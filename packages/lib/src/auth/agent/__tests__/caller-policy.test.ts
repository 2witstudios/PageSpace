import { describe, expect, it } from 'vitest';
import { decideAgentKeyMint, decideClaimCaller, type CallerCredentialClass } from '../caller-policy';

const CREDENTIALS: CallerCredentialClass[] = ['session', 'agent_grant_token', 'other_token'];

describe('decideClaimCaller — only the agent itself starts or polls its claim', () => {
  it("given the bearer door, should accept only the agent's own pagespace-agent token", () => {
    expect(decideClaimCaller({ door: 'bearer', credential: 'agent_grant_token', accountType: 'agent' })).toEqual({ status: 'ok' });
    expect(decideClaimCaller({ door: 'bearer', credential: 'session', accountType: 'agent' })).toEqual({ status: 'refused' });
    expect(decideClaimCaller({ door: 'bearer', credential: 'other_token', accountType: 'agent' })).toEqual({ status: 'refused' });
  });

  it("given the session door, should accept only the agent's own session", () => {
    expect(decideClaimCaller({ door: 'session', credential: 'session', accountType: 'agent' })).toEqual({ status: 'ok' });
    expect(decideClaimCaller({ door: 'session', credential: 'agent_grant_token', accountType: 'agent' })).toEqual({ status: 'refused' });
    expect(decideClaimCaller({ door: 'session', credential: 'other_token', accountType: 'agent' })).toEqual({ status: 'refused' });
  });

  it('given a human caller (a former owner, a throwaway account), should refuse on every door and credential', () => {
    for (const door of ['bearer', 'session'] as const) {
      for (const credential of CREDENTIALS) {
        expect(decideClaimCaller({ door, credential, accountType: 'human' })).toEqual({ status: 'refused' });
      }
    }
  });

  it('given a caller whose row could not be read, should fail closed', () => {
    expect(decideClaimCaller({ door: 'bearer', credential: 'agent_grant_token', accountType: null })).toEqual({ status: 'refused' });
    expect(decideClaimCaller({ door: 'session', credential: 'session', accountType: null })).toEqual({ status: 'refused' });
  });
});

describe('decideAgentKeyMint — the agent caps follow the caller, not the credential type', () => {
  it('given an agent signed in by SESSION (the browser door), should apply the agent caps', () => {
    expect(decideAgentKeyMint({ credential: 'session', accountType: 'agent' })).toEqual({ status: 'ok', agentCaps: true });
  });

  it("given the agent's own bearer, should apply the agent caps", () => {
    expect(decideAgentKeyMint({ credential: 'agent_grant_token', accountType: 'agent' })).toEqual({ status: 'ok', agentCaps: true });
  });

  it('given a human session, should mint uncapped as before', () => {
    expect(decideAgentKeyMint({ credential: 'session', accountType: 'human' })).toEqual({ status: 'ok', agentCaps: false });
  });

  it('given any other bearer, should refuse whoever holds it', () => {
    expect(decideAgentKeyMint({ credential: 'other_token', accountType: 'human' })).toEqual({ status: 'refused' });
    expect(decideAgentKeyMint({ credential: 'other_token', accountType: 'agent' })).toEqual({ status: 'refused' });
  });

  it('given a session whose account type could not be read, should fail closed to the caps', () => {
    expect(decideAgentKeyMint({ credential: 'session', accountType: null })).toEqual({ status: 'ok', agentCaps: true });
  });
});

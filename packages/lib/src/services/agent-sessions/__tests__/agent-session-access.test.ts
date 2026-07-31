/**
 * The GATHER wrapper, not the decision (that is decide-session-access.test.ts).
 * What must hold here: the right facts are fetched for the right session
 * shapes, absent rows answer session_not_found, and the end variant cannot
 * even ask about the capability.
 */
import { describe, it, expect } from 'vitest';
import { checkAgentSessionAccess, checkAgentSessionEndAccess, type AgentSessionAccessDeps } from '../agent-session-access';
import { DRIVE_ID, OWNER_ID, SESSION_ID } from './fakes';

const subject = { sessionId: SESSION_ID, ownerId: OWNER_ID, driveId: DRIVE_ID };

function makeDeps(over: Partial<AgentSessionAccessDeps> = {}): AgentSessionAccessDeps {
  return {
    findSession: async () => subject,
    resolveDriveMembership: async () => 'member',
    canRunCode: async () => true,
    ...over,
  };
}

describe('checkAgentSessionAccess', () => {
  it('given no such session, should answer session_not_found — a lookup fact, distinct from denial', async () => {
    const result = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: 'missing',
      deps: makeDeps({ findSession: async () => null }),
    });
    expect(result).toEqual({ allowed: false, reason: 'session_not_found' });
  });

  it('given a drive session, should resolve membership against the ROW driveId', async () => {
    const seen: Array<{ userId: string; driveId: string }> = [];
    await checkAgentSessionAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({
        resolveDriveMembership: async (input) => {
          seen.push(input);
          return 'member';
        },
      }),
    });
    expect(seen).toEqual([{ userId: 'user-2', driveId: DRIVE_ID }]);
  });

  it('given a global-assistant session, should NOT fetch a membership at all', async () => {
    const result = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({
        findSession: async () => ({ ...subject, driveId: null }),
        resolveDriveMembership: async () => {
          throw new Error('must not resolve a membership for a session with no drive');
        },
      }),
    });
    expect(result).toEqual({ allowed: true });
  });

  it('given a member allowed by everything, should allow', async () => {
    const result = await checkAgentSessionAccess({ requesterId: 'user-2', sessionId: SESSION_ID, deps: makeDeps() });
    expect(result).toEqual({ allowed: true });
  });

  it('given the capability check refuses, should deny with the capability reason', async () => {
    const result = await checkAgentSessionAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({ canRunCode: async () => false }),
    });
    expect(result).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });
});

describe('checkAgentSessionEndAccess', () => {
  it('given no such session, should answer session_not_found', async () => {
    const result = await checkAgentSessionEndAccess({
      requesterId: OWNER_ID,
      sessionId: 'missing',
      deps: makeDeps({ findSession: async () => null }),
    });
    expect(result).toEqual({ allowed: false, reason: 'session_not_found' });
  });

  it('gathers the REAL capability for a non-owner — a member without it cannot end (review H3)', async () => {
    const result = await checkAgentSessionEndAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({ canRunCode: async () => false }),
    });
    expect(result).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });

  it('a member WITH the capability may end — shared compute, ordinary session management', async () => {
    const result = await checkAgentSessionEndAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({ canRunCode: async () => true }),
    });
    expect(result).toEqual({ allowed: true });
  });

  it('given the session OWNER without drive membership OR capability, should still allow the end', async () => {
    // Release-of-compute is the owner's emergency exit — the short-circuit in
    // the pure decider, exercised through the gather.
    const result = await checkAgentSessionEndAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({ resolveDriveMembership: async () => 'none', canRunCode: async () => false }),
    });
    expect(result).toEqual({ allowed: true });
  });
});

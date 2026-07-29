import { describe, it, expect } from 'vitest';
import { checkAgentSessionAccess, checkAgentSessionEndAccess, type AgentSessionAccessDeps } from '../agent-session-access';
import { AGENT_PAGE_ID, OWNER_ID, SESSION_ID } from './fakes';

const subject = { sessionId: SESSION_ID, ownerId: OWNER_ID, agentPageId: AGENT_PAGE_ID };

function makeDeps(over: Partial<AgentSessionAccessDeps> = {}): AgentSessionAccessDeps {
  return {
    findSession: async () => subject,
    resolveConversationOwnership: async () => 'owner',
    resolvePagePermission: async () => 'view',
    canRunCode: async () => true,
    ...over,
  };
}

describe('checkAgentSessionAccess', () => {
  it('given the owner of a page-anchored session who may run code, should allow', async () => {
    const decision = await checkAgentSessionAccess({ requesterId: OWNER_ID, sessionId: SESSION_ID, deps: makeDeps() });
    expect(decision).toEqual({ allowed: true });
  });

  it('given no such session, should report it distinctly from a denial (404 vs 403)', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: 'nope',
      deps: makeDeps({ findSession: async () => null }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'session_not_found' });
  });

  it('should gather the facts and let the pure decider weigh them — a denial keeps its reason verbatim', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({ resolveConversationOwnership: async () => 'none' }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'not_shared' });
  });

  it('given a shared conversation on an accessible page, should allow a non-owner', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({ resolveConversationOwnership: async () => 'shared' }),
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('given no page access, should deny with the page reason', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({ resolvePagePermission: async () => 'none' }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'page_access_denied' });
  });

  it('given an unresolved page permission, should deny — unknown is never a grant', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({ resolvePagePermission: async () => null }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'page_access_denied' });
  });

  it('given a requester who may see the conversation but not run code, should deny distinctly', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({ canRunCode: async () => false }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });

  it('given a GLOBAL-ASSISTANT session, should not ask for a page permission at all', async () => {
    // There is no page to ask about — which is also why sharing the conversation
    // cannot widen it (the decider keeps it owner-only).
    let asked = false;
    const decision = await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({
        findSession: async () => ({ ...subject, agentPageId: null }),
        resolvePagePermission: async () => {
          asked = true;
          return 'view';
        },
      }),
    });

    expect(decision).toEqual({ allowed: true });
    expect(asked).toBe(false);
  });

  it('given a NON-owner on a global-assistant session, should deny even when the conversation is shared', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({
        findSession: async () => ({ ...subject, agentPageId: null }),
        resolveConversationOwnership: async () => 'shared',
      }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'global_assistant_not_owner' });
  });

  it('given a caller that mis-derives ownership, should fail closed rather than honor it', async () => {
    const decision = await checkAgentSessionAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: makeDeps({ resolveConversationOwnership: async () => 'owner' }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'ownership_mismatch' });
  });

  it('should look the conversation up by the SESSION ROW\'S id, not the caller\'s string', async () => {
    // sessionId ≡ conversationId, and the row is the authority on which one this
    // is — a caller-supplied id that resolved to a different row must not then be
    // used to ask about ownership.
    const seen: string[] = [];
    await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: 'whatever-the-caller-said',
      deps: makeDeps({
        resolveConversationOwnership: async ({ conversationId }) => {
          seen.push(conversationId);
          return 'owner';
        },
      }),
    });
    expect(seen).toEqual([SESSION_ID]);
  });

  it('should pass the requester and the session\'s agent page to the capability check', async () => {
    const seen: unknown[] = [];
    await checkAgentSessionAccess({
      requesterId: OWNER_ID,
      sessionId: SESSION_ID,
      deps: makeDeps({
        canRunCode: async (input) => {
          seen.push(input);
          return true;
        },
      }),
    });
    expect(seen).toEqual([{ userId: OWNER_ID, agentPageId: AGENT_PAGE_ID }]);
  });

  it('given an empty requester, should deny', async () => {
    const decision = await checkAgentSessionAccess({ requesterId: '', sessionId: SESSION_ID, deps: makeDeps() });
    expect(decision).toEqual({ allowed: false, reason: 'invalid_requester' });
  });
});

describe('checkAgentSessionEndAccess', () => {
  const endDeps = (over: Partial<Omit<AgentSessionAccessDeps, 'canRunCode'>> = {}): Omit<AgentSessionAccessDeps, 'canRunCode'> => {
    const { findSession, resolveConversationOwnership, resolvePagePermission } = makeDeps();
    return { findSession, resolveConversationOwnership, resolvePagePermission, ...over };
  };

  it('given the owner, should allow WITHOUT consulting any capability dep (none exists to consult)', async () => {
    const decision = await checkAgentSessionEndAccess({ requesterId: OWNER_ID, sessionId: SESSION_ID, deps: endDeps() });
    expect(decision).toEqual({ allowed: true });
  });

  it('given no such session, should report session_not_found', async () => {
    const decision = await checkAgentSessionEndAccess({
      requesterId: OWNER_ID,
      sessionId: 'nope',
      deps: endDeps({ findSession: async () => null }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'session_not_found' });
  });

  it('given a requester with no claim on the conversation, should still deny', async () => {
    const decision = await checkAgentSessionEndAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: endDeps({ resolveConversationOwnership: async () => 'none' }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'not_shared' });
  });

  it('given a page-anchored session the requester cannot view, should deny on the page gate', async () => {
    const decision = await checkAgentSessionEndAccess({
      requesterId: 'user-2',
      sessionId: SESSION_ID,
      deps: endDeps({
        resolveConversationOwnership: async () => 'shared',
        resolvePagePermission: async () => 'none',
      }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'page_access_denied' });
  });
});

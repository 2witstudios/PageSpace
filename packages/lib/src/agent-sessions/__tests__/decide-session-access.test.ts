import { describe, it, expect } from 'vitest';
import {
  decideAgentSessionAccess,
  type DecideAgentSessionAccessInput,
  type AgentSessionAccessSubject,
} from '../decide-session-access';

const OWNER = 'user-owner';
const OTHER = 'user-other';

const session: AgentSessionAccessSubject = { sessionId: 'conv-1', ownerId: OWNER, agentPageId: 'page-1' };
const globalSession: AgentSessionAccessSubject = { sessionId: 'conv-2', ownerId: OWNER, agentPageId: null };

function input(overrides: Partial<DecideAgentSessionAccessInput> = {}): DecideAgentSessionAccessInput {
  return {
    requesterId: OWNER,
    session,
    conversationOwnership: 'owner',
    pagePermission: 'view',
    canRunCode: true,
    ...overrides,
  };
}

describe('decideAgentSessionAccess — allow', () => {
  it('given the owner with page access and canRunCode, should allow', () => {
    expect(decideAgentSessionAccess(input())).toEqual({ allowed: true });
  });

  it('given edit-level page permission, should allow (edit implies view)', () => {
    expect(decideAgentSessionAccess(input({ pagePermission: 'edit' })).allowed).toBe(true);
  });

  it('given a non-owner on a SHARED conversation with page access, should allow', () => {
    const decision = decideAgentSessionAccess(
      input({ requesterId: OTHER, conversationOwnership: 'shared' }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('given the owner of a global-assistant session (agentPageId null), should allow', () => {
    const decision = decideAgentSessionAccess(
      input({ session: globalSession, pagePermission: null }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('given a global-assistant session, should ignore any page permission passed in', () => {
    const decision = decideAgentSessionAccess(
      input({ session: globalSession, pagePermission: 'none' }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('decideAgentSessionAccess — ownership', () => {
  it('given a requester who is neither owner nor shared, should deny', () => {
    const decision = decideAgentSessionAccess(
      input({ requesterId: OTHER, conversationOwnership: 'none' }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'not_shared' });
  });

  it('given a caller that claims ownership for a non-owner, should deny (fail closed on a mis-derived input)', () => {
    const decision = decideAgentSessionAccess(
      input({ requesterId: OTHER, conversationOwnership: 'owner' }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'ownership_mismatch' });
  });

  it('given an empty requesterId, should deny (an unauthenticated caller is nobody)', () => {
    const decision = decideAgentSessionAccess(input({ requesterId: '' }));
    expect(decision).toEqual({ allowed: false, reason: 'invalid_requester' });
  });

  it('given the owner, should allow even when the ownership input says none (identity beats the hint)', () => {
    expect(decideAgentSessionAccess(input({ conversationOwnership: 'none' })).allowed).toBe(true);
  });
});

describe('decideAgentSessionAccess — page permission', () => {
  it('given no view permission on a non-null agentPageId, should deny', () => {
    const decision = decideAgentSessionAccess(input({ pagePermission: 'none' }));
    expect(decision).toEqual({ allowed: false, reason: 'page_access_denied' });
  });

  it('given an unresolved page permission on a non-null agentPageId, should deny (fail closed)', () => {
    const decision = decideAgentSessionAccess(input({ pagePermission: null }));
    expect(decision).toEqual({ allowed: false, reason: 'page_access_denied' });
  });

  it('given a shared conversation but no page access, should deny — both gates apply', () => {
    const decision = decideAgentSessionAccess(
      input({ requesterId: OTHER, conversationOwnership: 'shared', pagePermission: 'none' }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'page_access_denied' });
  });

  it('given a NON-owner on a shared GLOBAL-assistant session, should deny (no page to share through)', () => {
    const decision = decideAgentSessionAccess(
      input({ requesterId: OTHER, session: globalSession, conversationOwnership: 'shared', pagePermission: null }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'global_assistant_not_owner' });
  });
});

describe('decideAgentSessionAccess — code execution', () => {
  it('given canRunCode false, should deny with a DISTINCT reason', () => {
    const decision = decideAgentSessionAccess(input({ canRunCode: false }));
    expect(decision).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });

  it('given canRunCode false, should not be confused with a permission denial', () => {
    const codeDenial = decideAgentSessionAccess(input({ canRunCode: false }));
    const pageDenial = decideAgentSessionAccess(input({ pagePermission: 'none' }));
    if (codeDenial.allowed || pageDenial.allowed) throw new Error('expected two denials');
    expect(codeDenial.reason).not.toBe(pageDenial.reason);
  });

  it('given canRunCode false on a global-assistant session, should still deny for code execution', () => {
    const decision = decideAgentSessionAccess(
      input({ session: globalSession, pagePermission: null, canRunCode: false }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });

  it('should report the identity denial before the capability denial when both fail', () => {
    const decision = decideAgentSessionAccess(
      input({ requesterId: OTHER, conversationOwnership: 'none', canRunCode: false }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'not_shared' });
  });
});

describe('decideAgentSessionAccess — one decision for web and realtime', () => {
  it('should be a pure function of its input (same input, same verdict)', () => {
    expect(decideAgentSessionAccess(input())).toEqual(decideAgentSessionAccess(input()));
  });

  it('should never return a reason alongside an allow', () => {
    const decision = decideAgentSessionAccess(input()) as { allowed: boolean; reason?: string };
    expect(decision.reason).toBeUndefined();
  });
});

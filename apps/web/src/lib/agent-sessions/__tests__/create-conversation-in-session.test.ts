/**
 * Create-a-conversation-in-a-session, now composed from two independent
 * steps: (1) an ordinary idempotent "insert if missing" (session-agnostic),
 * then (2) `claimConversationInSessionWith` — the ONE place
 * `conversations.sessionId` is ever written. The property under test is
 * still review finding H1's fix (an already-existing conversation is bound
 * ONLY as an idempotent retry of itself — never adopted, never rebound,
 * never someone else's), but the mechanism moved: claim's own gates now
 * enforce it, not a bespoke check re-implemented in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createConversationInSessionWith,
  ConversationUnavailableError,
  AgentNotInSessionDriveError,
  SessionFullError,
  type CreateConversationInSessionDeps,
} from '../create-conversation-in-session';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-sessions/plan-spawn-session';

// What claim's own `findConversation` reads immediately after the creator
// step ran, for a genuinely fresh (or freshly-idempotent) page conversation.
const FRESH_UNBOUND_PAGE_ROW = {
  userId: 'user-1',
  type: 'page',
  contextId: 'agent-1',
  sessionId: null,
  isActive: true,
};

const FRESH_UNBOUND_GLOBAL_ROW = {
  userId: 'user-1',
  type: 'global',
  contextId: null,
  sessionId: null,
  isActive: true,
};

let deps: {
  createPageConversation: ReturnType<typeof vi.fn>;
  createGlobalConversation: ReturnType<typeof vi.fn>;
  findConversation: ReturnType<typeof vi.fn>;
  findAgentDriveId: ReturnType<typeof vi.fn>;
  findSession: ReturnType<typeof vi.fn>;
  countActiveConversations: ReturnType<typeof vi.fn>;
  claimConversation: ReturnType<typeof vi.fn>;
};

const input = (overrides: Partial<{ agentPageId: string | null; sessionId: string }> = {}) => ({
  conversationId: 'conv-1',
  userId: 'user-1',
  agentPageId: 'agent-1' as string | null,
  sessionId: 'ses-1',
  ...overrides,
});

const run = () => createConversationInSessionWith(deps as CreateConversationInSessionDeps, input());

beforeEach(() => {
  deps = {
    createPageConversation: vi.fn(async () => 'created' as const),
    createGlobalConversation: vi.fn(async () => {}),
    findConversation: vi.fn(async () => FRESH_UNBOUND_PAGE_ROW),
    findAgentDriveId: vi.fn(async () => 'drive-1'),
    findSession: vi.fn(async () => ({ driveId: 'drive-1', endedAt: null })),
    countActiveConversations: vi.fn(async () => 0),
    claimConversation: vi.fn(async () => 'claimed' as const),
  };
});

describe('page arm', () => {
  it('creates session-agnostic, then claims separately — sessionId never rides the insert', async () => {
    await run();
    expect(deps.createPageConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      agentPageId: 'agent-1',
      title: null,
    });
    expect(deps.claimConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      sessionId: 'ses-1',
    });
  });

  it('accepts an existing row already bound HERE as an idempotent retry', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, sessionId: 'ses-1' });
    await expect(run()).resolves.toBeUndefined();
    // Idempotent — claim never re-writes an already-matching binding.
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it("refuses someone else's conversation — the H1 hijack", async () => {
    // The old shape silently succeeded here and then UPDATEd the binding,
    // letting any caller pull a foreign thread into their own sandbox. Now
    // it's claim's ownership gate that refuses it.
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, userId: 'attacker-target' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it("refuses rebinding the caller's OWN thread to a different session — a move is a fork", async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, sessionId: 'ses-other' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('ADOPTS an existing UNBOUND thread — binding a never-claimed row is not a rebind', async () => {
    // Intentional behavior change from the old design: binding-from-null used
    // to be refused here too (this file's OWN idempotent-retry check treated
    // any non-matching-session row as unavailable, including a null one).
    // Now that the binding is a separately guarded, ownership-checked claim
    // rather than something only ever allowed inside an INSERT, a caller's
    // own still-unbound row is exactly what claim exists to bind — see
    // `claim-conversation-in-session.ts`. Not a security regression (still
    // gated on `userId` matching); every real caller generates a fresh CUID2
    // for this call, so an actual pre-existing collision doesn't arise by
    // accident.
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue(FRESH_UNBOUND_PAGE_ROW);
    await expect(run()).resolves.toBeUndefined();
    expect(deps.claimConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      sessionId: 'ses-1',
    });
  });

  it('refuses a row anchored to a different agent page — the repository\'s existence check has no contextId filter', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, contextId: 'agent-other' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    // Caught before claim is ever reached — an id collision with a
    // different agent's conversation must not become "which session should
    // I bind the wrong agent's thread into".
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('refuses a non-page row wearing the same id', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, type: 'global' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('a legacy message-owner conflict throws WITHOUT an idempotency escape', async () => {
    // The sub-bug this pins: the old path answered 201 with a conversationId
    // that had no row. A conflict means nothing was created and nothing may
    // be claimed.
    deps.createPageConversation.mockResolvedValue('message_owner_conflict');
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.findConversation).not.toHaveBeenCalled();
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('a row that vanished between outcomes is unavailability, not success', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });
});

describe('global arm', () => {
  it('creates session-agnostic through the ownership-guarded resolver, then claims separately', async () => {
    deps.findConversation.mockResolvedValue(FRESH_UNBOUND_GLOBAL_ROW);
    await createConversationInSessionWith(
      deps as CreateConversationInSessionDeps,
      input({ agentPageId: null }),
    );
    expect(deps.createGlobalConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      title: null,
    });
    expect(deps.createPageConversation).not.toHaveBeenCalled();
    expect(deps.claimConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      sessionId: 'ses-1',
    });
  });

  it('folds EVERY resolver refusal into one unavailability answer', async () => {
    // Ownership or a history-deleted collision — distinguishing them would
    // tell an id-guessing caller which one it hit.
    deps.createGlobalConversation.mockRejectedValue(new Error('ConversationOwnershipError'));
    await expect(
      createConversationInSessionWith(deps as CreateConversationInSessionDeps, input({ agentPageId: null })),
    ).rejects.toThrow(ConversationUnavailableError);
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });
});

describe('worker labels', () => {
  it('a title travels to the creator AT BIRTH — the label the sidebar shows (codex P2)', async () => {
    await createConversationInSessionWith(deps as CreateConversationInSessionDeps, {
      ...input(),
      title: 'research worker',
    });
    expect(deps.createPageConversation).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'research worker' }),
    );
  });
});

describe('the cross-drive gate (one binding path, review #43)', () => {
  it("refuses an agent from a DIFFERENT drive — a session's tenant, payer and access all derive from ITS drive", async () => {
    deps.findAgentDriveId.mockResolvedValue('drive-other');
    await expect(run()).rejects.toThrow(AgentNotInSessionDriveError);
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('a GLOBAL session (driveId null) may host any accessible agent — no drive to mismatch against', async () => {
    deps.findSession.mockResolvedValue({ driveId: null, endedAt: null });
    await run();
    expect(deps.createPageConversation).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: 'agent-1' }),
    );
    expect(deps.claimConversation).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses-1' }),
    );
  });

  it('the assistant is exempt — it has no drive to mismatch', async () => {
    deps.findConversation.mockResolvedValue(FRESH_UNBOUND_GLOBAL_ROW);
    await createConversationInSessionWith(deps as CreateConversationInSessionDeps, input({ agentPageId: null }));
    expect(deps.findAgentDriveId).not.toHaveBeenCalled();
    expect(deps.createGlobalConversation).toHaveBeenCalled();
  });

  it('fails CLOSED when the agent cannot be resolved — a trashed or non-agent page never binds', async () => {
    deps.findAgentDriveId.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the session cannot be resolved', async () => {
    deps.findSession.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('a same-drive agent passes the gate and creates', async () => {
    await expect(run()).resolves.toBeUndefined();
    expect(deps.createPageConversation).toHaveBeenCalled();
  });
});

describe('the per-session conversation cap (issue #2262 finding 2 — now enforced entirely by claim)', () => {
  // This module is the ONE write path both HTTP routes
  // (agent-sessions/[sessionId]/conversations, page-agents/[agentId]/conversations)
  // and the session-tools spawn dep (createWorkerSession) funnel through, so a
  // cap enforced by the claim step it composes covers every conversation-
  // minting entry point at once — including the ones that never call the
  // pure tool-side planner.

  it('the plain conversation row still gets created even when the session is at its ceiling — only the BINDING is refused', async () => {
    // Intentional behavior change: creation and binding are now decoupled
    // steps, so a full session no longer prevents the row from existing at
    // all — it just stays sessionless, same as any other cap refusal would
    // leave it. No cleanup is needed: a sessionless conversation is an
    // ordinary, harmless state, not an orphan.
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    await expect(run()).rejects.toThrow(SessionFullError);
    expect(deps.createPageConversation).toHaveBeenCalled();
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('same for the global arm — the resolver still runs; only the claim is refused', async () => {
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    deps.findConversation.mockResolvedValue(FRESH_UNBOUND_GLOBAL_ROW);
    await expect(
      createConversationInSessionWith(deps as CreateConversationInSessionDeps, input({ agentPageId: null })),
    ).rejects.toThrow(SessionFullError);
    expect(deps.createGlobalConversation).toHaveBeenCalled();
  });

  it('allows creation with one conversation slot left', async () => {
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS - 1);
    await expect(run()).resolves.toBeUndefined();
    expect(deps.createPageConversation).toHaveBeenCalled();
  });

  it('lets an IDEMPOTENT RETRY of an existing conversation in THIS session through, even at the ceiling — claim never checks the cap for one', async () => {
    // A retry mints nothing new, so the cap must not stand between a caller
    // and its own already-created, already-bound conversation. Claim's own
    // `already_in_session` branch returns before its cap check runs at all.
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, sessionId: 'ses-1' });
    await expect(run()).resolves.toBeUndefined();
    expect(deps.countActiveConversations).not.toHaveBeenCalled();
  });

  it('refuses an id bound to a DIFFERENT session regardless of the cap — that row was never available here, capacity or not', async () => {
    // Claim's "any other session" gate fires before its cap check ever runs,
    // so this is `ConversationUnavailableError`, not `SessionFullError` — the
    // cap is moot when the row was refused for a more fundamental reason.
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, sessionId: 'ses-other' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });
});

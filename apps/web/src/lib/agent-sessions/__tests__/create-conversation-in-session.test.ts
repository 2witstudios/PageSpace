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

describe('the per-session conversation cap (issue #2262 finding 2, plus the P1 orphan-row finding on this PR)', () => {
  // This module is the ONE write path both HTTP routes
  // (agent-sessions/[sessionId]/conversations, page-agents/[agentId]/conversations)
  // and the session-tools spawn dep (createWorkerSession) funnel through, so a
  // cap enforced here bounds every conversation-minting entry point at once —
  // including the ones with no pure-planner preflight of their own.
  //
  // Checked BEFORE either creator runs (review finding — chatgpt-codex-
  // connector, P1): letting the plain row get created regardless, and only
  // refusing the BINDING afterward, left a blank, sessionless conversation
  // behind in the caller's history on every ordinary cap-exceeded mint
  // attempt — creation and binding are decoupled by design, but a doomed
  // mint must not still leave visible clutter. The atomic claim call remains
  // the ENFORCED backstop for the narrow race window between this pre-check
  // and the actual write; this pre-check only short-circuits the common,
  // non-racy case.

  it('refuses a NEW page conversation BEFORE creating anything when the session is already at its ceiling', async () => {
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    await expect(run()).rejects.toThrow(SessionFullError);
    expect(deps.createPageConversation).not.toHaveBeenCalled();
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('refuses a NEW global conversation BEFORE creating anything when the session is already at its ceiling', async () => {
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    await expect(
      createConversationInSessionWith(deps as CreateConversationInSessionDeps, input({ agentPageId: null })),
    ).rejects.toThrow(SessionFullError);
    expect(deps.createGlobalConversation).not.toHaveBeenCalled();
  });

  it('allows creation with one conversation slot left', async () => {
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS - 1);
    await expect(run()).resolves.toBeUndefined();
    expect(deps.createPageConversation).toHaveBeenCalled();
  });

  it('lets an IDEMPOTENT RETRY of an existing conversation in THIS session through, even at the ceiling', async () => {
    // A retry mints nothing new, so the cap must not stand between a caller
    // and its own already-created, already-bound conversation — the
    // pre-check's own retry exemption covers this (before the insert is
    // even attempted a second time), and claim's own `already_in_session`
    // is the second, independent guarantee of the same idempotency.
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, sessionId: 'ses-1' });
    await expect(run()).resolves.toBeUndefined();
  });

  it('refuses an id bound to a DIFFERENT session at the ceiling with SessionFullError — the pre-check cannot yet tell that apart from "no room", and claim never even runs to give the more specific answer', async () => {
    // Matches the pre-collapse behavior exactly: the retry-exemption check
    // only recognizes a row already bound to THIS session as safe to let
    // through the cap; anything else (including a different session's row)
    // is indistinguishable from "genuinely no room" at this pre-check layer.
    deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...FRESH_UNBOUND_PAGE_ROW, sessionId: 'ses-other' });
    await expect(run()).rejects.toThrow(SessionFullError);
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the session cannot be resolved, before weighing the cap at all', async () => {
    deps.findSession.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.countActiveConversations).not.toHaveBeenCalled();
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('refuses an ENDED session before weighing the cap or creating anything', async () => {
    deps.findSession.mockResolvedValue({ driveId: 'drive-1', endedAt: new Date('2026-01-01') });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.countActiveConversations).not.toHaveBeenCalled();
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });
});

/**
 * The one write path for the thread→session binding. The property under test
 * is review finding H1's fix: the binding travels inside the creator's
 * INSERT, and an already-existing conversation is accepted ONLY as an
 * idempotent retry (same owner, same session, same anchor) — never adopted,
 * never rebound, never someone else's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createConversationInSessionWith,
  ConversationUnavailableError,
  type CreateConversationInSessionDeps,
} from '../create-conversation-in-session';

const OWN_ROW = {
  userId: 'user-1',
  type: 'page',
  contextId: 'agent-1',
  sessionId: 'ses-1',
};

let deps: {
  createPageConversation: ReturnType<typeof vi.fn>;
  createGlobalConversation: ReturnType<typeof vi.fn>;
  findConversation: ReturnType<typeof vi.fn>;
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
    findConversation: vi.fn(async () => OWN_ROW),
  };
});

describe('page arm', () => {
  it('creates WITH the binding — sessionId rides the insert, and success needs no row lookup', async () => {
    await run();
    expect(deps.createPageConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      agentPageId: 'agent-1',
      sessionId: 'ses-1',
      title: null,
    });
    expect(deps.findConversation).not.toHaveBeenCalled();
  });

  it('accepts an existing row ONLY as an idempotent retry of itself', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    await expect(run()).resolves.toBeUndefined();
  });

  it("refuses someone else's conversation — the H1 hijack", async () => {
    // The old shape silently succeeded here and then UPDATEd the binding,
    // letting any caller pull a foreign thread into their own sandbox.
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...OWN_ROW, userId: 'attacker-target' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });

  it("refuses rebinding the caller's OWN thread to a different session — a move is a fork", async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...OWN_ROW, sessionId: 'ses-other' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });

  it('refuses adopting an UNBOUND pre-session thread — binding-from-null is still a rebind', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...OWN_ROW, sessionId: null });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });

  it('refuses a row anchored to a different agent page', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...OWN_ROW, contextId: 'agent-other' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });

  it('refuses a non-page row wearing the same id', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue({ ...OWN_ROW, type: 'global' });
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });

  it('a legacy message-owner conflict throws WITHOUT an idempotency escape', async () => {
    // The sub-bug this pins: the old path answered 201 with a conversationId
    // that had no row. A conflict means nothing was created and nothing may
    // be claimed.
    deps.createPageConversation.mockResolvedValue('message_owner_conflict');
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
    expect(deps.findConversation).not.toHaveBeenCalled();
  });

  it('a row that vanished between outcomes is unavailability, not success', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversation.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(ConversationUnavailableError);
  });
});

describe('global arm', () => {
  it('creates WITH the binding through the ownership-guarded resolver', async () => {
    await createConversationInSessionWith(
      deps as CreateConversationInSessionDeps,
      input({ agentPageId: null }),
    );
    expect(deps.createGlobalConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      sessionId: 'ses-1',
      title: null,
    });
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('folds EVERY resolver refusal into one unavailability answer', async () => {
    // Ownership, wrong type, binding mismatch — distinguishing them would
    // tell an id-guessing caller which one it hit.
    deps.createGlobalConversation.mockRejectedValue(new Error('ConversationBindingConflictError'));
    await expect(
      createConversationInSessionWith(deps as CreateConversationInSessionDeps, input({ agentPageId: null })),
    ).rejects.toThrow(ConversationUnavailableError);
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

/**
 * The never-bound-conversation claim decision — the property under test is
 * that this is a NARROW extension of the "no rebind" invariant, not a
 * regression of it: only a truly unbound row, owned by the caller, may ever
 * be claimed. Any row already bound to a session — even the target session,
 * even one the caller owns — is either an idempotent no-op or a flat
 * refusal, never a fresh write. Mirrors `reopen-conversation-in-session.test.ts`
 * and `create-conversation-in-session.test.ts`'s style.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-session';
import {
  claimConversationInSessionWith,
  type ClaimConversationInSessionDeps,
} from '../claim-conversation-in-session';

const UNBOUND_PAGE_ROW = {
  userId: 'user-1',
  type: 'page',
  contextId: 'agent-1',
  workspaceId: null,
  isActive: true,
};

let deps: {
  findConversation: ReturnType<typeof vi.fn>;
  findAgentDriveId: ReturnType<typeof vi.fn>;
  findSession: ReturnType<typeof vi.fn>;
  countActiveConversations: ReturnType<typeof vi.fn>;
  claimConversation: ReturnType<typeof vi.fn>;
};

const input = { conversationId: 'conv-1', userId: 'user-1', workspaceId: 'ses-1' };
const run = () => claimConversationInSessionWith(deps as ClaimConversationInSessionDeps, input);

beforeEach(() => {
  deps = {
    findConversation: vi.fn(async () => UNBOUND_PAGE_ROW),
    findAgentDriveId: vi.fn(async () => 'drive-1'),
    findSession: vi.fn(async () => ({ driveId: 'drive-1', endedAt: null })),
    countActiveConversations: vi.fn(async () => 0),
    claimConversation: vi.fn(async () => 'claimed' as const),
  };
});

describe('claimConversationInSessionWith', () => {
  it('claims a never-bound row the caller owns', async () => {
    await expect(run()).resolves.toBe('claimed');
    expect(deps.claimConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      workspaceId: 'ses-1',
    });
  });

  it('given no such row, answers not_found', async () => {
    deps.findConversation.mockResolvedValue(null);
    await expect(run()).resolves.toBe('not_found');
    expect(deps.findSession).not.toHaveBeenCalled();
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('the H1 hijack — refuses a row owned by someone else, checked before every other gate', async () => {
    deps.findConversation.mockResolvedValue({ ...UNBOUND_PAGE_ROW, userId: 'attacker-target' });
    await expect(run()).resolves.toBe('not_found');
    expect(deps.findSession).not.toHaveBeenCalled();
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('refuses a history-deleted row', async () => {
    deps.findConversation.mockResolvedValue({ ...UNBOUND_PAGE_ROW, isActive: false });
    await expect(run()).resolves.toBe('not_found');
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('refuses a row already bound to ANOTHER session — a move is a fork, never a rebind', async () => {
    deps.findConversation.mockResolvedValue({ ...UNBOUND_PAGE_ROW, workspaceId: 'ses-other' });
    await expect(run()).resolves.toBe('not_found');
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('refuses a row of type "client" — API-managed threads have no in-app viewer to grant a sandbox to', async () => {
    deps.findConversation.mockResolvedValue({ ...UNBOUND_PAGE_ROW, type: 'client', contextId: null });
    await expect(run()).resolves.toBe('not_found');
    expect(deps.claimConversation).not.toHaveBeenCalled();
  });

  it('claims a never-bound GLOBAL row too', async () => {
    deps.findConversation.mockResolvedValue({
      userId: 'user-1',
      type: 'global',
      contextId: null,
      workspaceId: null,
      isActive: true,
    });
    await expect(run()).resolves.toBe('claimed');
    expect(deps.findAgentDriveId).not.toHaveBeenCalled();
  });

  describe('idempotency', () => {
    it('a row already bound to the TARGET session is an idempotent no-op — no write, no cap check', async () => {
      deps.findConversation.mockResolvedValue({ ...UNBOUND_PAGE_ROW, workspaceId: 'ses-1' });
      await expect(run()).resolves.toBe('already_in_session');
      expect(deps.countActiveConversations).not.toHaveBeenCalled();
      expect(deps.claimConversation).not.toHaveBeenCalled();
    });

    it('a race that claims the row between the check and the write folds into not_found, never a silent success', async () => {
      deps.claimConversation.mockResolvedValue('noop');
      await expect(run()).resolves.toBe('not_found');
    });
  });

  describe('session liveness', () => {
    it('fails CLOSED when the session cannot be resolved', async () => {
      deps.findSession.mockResolvedValue(null);
      await expect(run()).resolves.toBe('not_found');
      expect(deps.claimConversation).not.toHaveBeenCalled();
    });

    it('an ENDED session is a valid claim target — lifecycle state never gates a permitted claim (issue #2335); the runtime reopens its listing', async () => {
      deps.findSession.mockResolvedValue({ driveId: 'drive-1', endedAt: new Date('2026-01-01') });
      await expect(run()).resolves.toBe('claimed');
      expect(deps.claimConversation).toHaveBeenCalled();
    });
  });

  describe('the cross-drive gate', () => {
    it("refuses a page conversation whose agent is in a DIFFERENT drive than the session's", async () => {
      deps.findAgentDriveId.mockResolvedValue('drive-other');
      await expect(run()).resolves.toBe('cross_drive_denied');
      expect(deps.claimConversation).not.toHaveBeenCalled();
    });

    it('a GLOBAL session (driveId null) may host any accessible agent — no drive to mismatch against', async () => {
      deps.findSession.mockResolvedValue({ driveId: null, endedAt: null });
      deps.findAgentDriveId.mockResolvedValue('drive-other');
      await expect(run()).resolves.toBe('claimed');
    });

    it('fails CLOSED when the agent cannot be resolved — a trashed or non-agent page never claims', async () => {
      deps.findAgentDriveId.mockResolvedValue(null);
      await expect(run()).resolves.toBe('not_found');
      expect(deps.claimConversation).not.toHaveBeenCalled();
    });
  });

  describe('the per-session conversation cap', () => {
    it('refuses when the session already holds MAX_SESSION_CONVERSATIONS open listings', async () => {
      deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
      await expect(run()).resolves.toBe('session_full');
      expect(deps.claimConversation).not.toHaveBeenCalled();
    });

    it('allows claiming with room for exactly one more', async () => {
      deps.countActiveConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS - 1);
      await expect(run()).resolves.toBe('claimed');
    });
  });
});

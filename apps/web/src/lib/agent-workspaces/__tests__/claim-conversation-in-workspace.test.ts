/**
 * CLAIMING IS CREATING THE NODE.
 *
 * The decision this suite pins is what survives the move of membership into the
 * tree, and what does not:
 *
 *  - **The ownership gate survives, first and unconditionally.** It is the one
 *    rule no index can state — the chat-target index knows a thread has one
 *    home, not whose thread it is — so it is checked before any branch can
 *    answer for a foreign row.
 *  - **The write-once binding survives as a PRE-CHECK, not as the enforcement.**
 *    `findWorkspaceOfConversation` answers the ordinary case; the unique index
 *    answers the racing one, and this suite pins that a `bound_elsewhere` from
 *    the write is reported the same way as a losing pre-check.
 *  - **The cap does not appear here at all.** It moved into `admit`, decided
 *    against the tree inside the locked transaction, so there is no
 *    `countActiveConversations` dep left to mock — which is itself the
 *    assertion: a count read out here could not have bounded the write.
 *
 * Every refusal test asserts `admitConversation` was NOT called: a gate that
 * refuses after the membership write has run is not a gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  claimConversationInSessionWith,
  type ClaimConversationInSessionDeps,
} from '../claim-conversation-in-workspace';

interface MockDeps extends ClaimConversationInSessionDeps<unknown> {
  findConversation: ReturnType<typeof vi.fn>;
  findWorkspaceOfConversation: ReturnType<typeof vi.fn>;
  findAgentDriveId: ReturnType<typeof vi.fn>;
  findSession: ReturnType<typeof vi.fn>;
  admitConversation: ReturnType<typeof vi.fn>;
}

const OWNER = 'user-1';
const WORKSPACE = 'ws-1';

function makeDeps(overrides: Partial<Record<keyof MockDeps, unknown>> = {}): MockDeps {
  return {
    findConversation: vi.fn(async () => ({
      userId: OWNER,
      type: 'page',
      contextId: 'agent-1',
      isActive: true,
    })),
    findWorkspaceOfConversation: vi.fn(async () => null),
    findAgentDriveId: vi.fn(async () => 'drive-1'),
    findSession: vi.fn(async () => ({ driveId: 'drive-1', endedAt: null })),
    admitConversation: vi.fn(async () => 'admitted' as const),
    ...overrides,
  } as MockDeps;
}

const input = { conversationId: 'conv-1', userId: OWNER, workspaceId: WORKSPACE };

describe('claimConversationInSessionWith', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('creates the node, and that is the whole of the claim', async () => {
    expect(await claimConversationInSessionWith(deps, input)).toBe('claimed');
    expect(deps.admitConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: WORKSPACE,
      attach: false,
    });
  });

  it('leaves the thread PARKED unless the caller asks otherwise', async () => {
    // Parked is membership. A claim arriving from the console has no pane
    // waiting for it, and an attached admission would place one the user did
    // not ask for.
    await claimConversationInSessionWith(deps, input);
    expect(deps.admitConversation).toHaveBeenCalledWith(expect.objectContaining({ attach: false }));

    await claimConversationInSessionWith(deps, { ...input, attach: true });
    expect(deps.admitConversation).toHaveBeenLastCalledWith(expect.objectContaining({ attach: true }));
  });

  describe('the gates, each of which writes nothing', () => {
    it('refuses a conversation that does not exist', async () => {
      deps.findConversation.mockResolvedValue(null);
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses SOMEONE ELSE\'S conversation — the one rule no index states', async () => {
      deps.findConversation.mockResolvedValue({
        userId: 'user-2',
        type: 'page',
        contextId: 'agent-1',
        isActive: true,
      });
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses a history-deleted conversation', async () => {
      deps.findConversation.mockResolvedValue({
        userId: OWNER,
        type: 'page',
        contextId: 'agent-1',
        isActive: false,
      });
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses an API-managed (`client`) thread, which has no in-app viewer', async () => {
      deps.findConversation.mockResolvedValue({
        userId: OWNER,
        type: 'client',
        contextId: 'drive-1',
        isActive: true,
      });
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses a thread ALREADY BOUND to another workspace, uniformly', async () => {
      deps.findWorkspaceOfConversation.mockResolvedValue('ws-other');
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses when the workspace does not exist', async () => {
      deps.findSession.mockResolvedValue(null);
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses an agent from another DRIVE, and says so', async () => {
      deps.findAgentDriveId.mockResolvedValue('drive-2');
      expect(await claimConversationInSessionWith(deps, input)).toBe('cross_drive_denied');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('refuses a page thread whose agent is gone', async () => {
      deps.findAgentDriveId.mockResolvedValue(null);
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle state never refuses a permitted claim (issue #2335)', () => {
    it('admits into an ENDED workspace', async () => {
      deps.findSession.mockResolvedValue({ driveId: 'drive-1', endedAt: new Date() });
      expect(await claimConversationInSessionWith(deps, input)).toBe('claimed');
      expect(deps.admitConversation).toHaveBeenCalled();
    });

    it('exempts a GLOBAL workspace from the cross-drive rule', async () => {
      deps.findSession.mockResolvedValue({ driveId: null, endedAt: null });
      deps.findAgentDriveId.mockResolvedValue('drive-9');
      expect(await claimConversationInSessionWith(deps, input)).toBe('claimed');
    });

    it('needs no agent at all for a global thread', async () => {
      deps.findConversation.mockResolvedValue({
        userId: OWNER,
        type: 'global',
        contextId: null,
        isActive: true,
      });
      expect(await claimConversationInSessionWith(deps, input)).toBe('claimed');
      expect(deps.findAgentDriveId).not.toHaveBeenCalled();
    });
  });

  describe('what the membership write answers', () => {
    it('a thread this workspace already holds is idempotent, not an error', async () => {
      deps.findWorkspaceOfConversation.mockResolvedValue(WORKSPACE);
      expect(await claimConversationInSessionWith(deps, input)).toBe('already_in_session');
      expect(deps.admitConversation).not.toHaveBeenCalled();
    });

    it('reports the WRITE\'s own idempotency too, when the pre-check missed it', async () => {
      // The pre-read said "no home" and the tree said "already here" — a claim
      // that lost a race to another tab. Same answer either way.
      deps.admitConversation.mockResolvedValue('already_a_member');
      expect(await claimConversationInSessionWith(deps, input)).toBe('already_in_session');
    });

    it('surfaces the cap the TREE enforced', async () => {
      deps.admitConversation.mockResolvedValue('session_full');
      expect(await claimConversationInSessionWith(deps, input)).toBe('session_full');
    });

    it('collapses the INDEX\'s refusal into the same "not found" the pre-check gives', async () => {
      // The unique chat-target index refused: between the pre-read and the
      // write, someone else claimed this thread. An id-guessing caller must not
      // be able to tell that from "there is no such thread".
      deps.admitConversation.mockResolvedValue('bound_elsewhere');
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
    });

    it('collapses a tree refusal into the same answer', async () => {
      deps.admitConversation.mockResolvedValue('refused');
      expect(await claimConversationInSessionWith(deps, input)).toBe('not_found');
    });
  });
});

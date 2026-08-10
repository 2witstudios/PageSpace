// @vitest-environment node
/**
 * THE SECOND EXPEL — the half of a history delete that runs AFTER the row is
 * gone.
 *
 * A history delete is two writes that cannot be one: `expelConversationFromSession`
 * removes the node under the workspace lock, and `softDeleteConversation` flips
 * `isActive` through message deactivation, room kicks and emits that would all
 * have to take an executor to join the first one's transaction. Ordering them
 * expel-then-delete makes the survivable failure the one that can happen — on a
 * CRASH. It does nothing about a concurrent claim, which fits neatly in the gap:
 * the thread is homeless and still alive there, which is exactly what a claim
 * admits, so the delete lands on a conversation a node is holding.
 *
 * This suite is for the two properties of the second expel that a route test
 * cannot see, and that a first cut of it got wrong in both directions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findWorkspaceOfChat, membershipWrite, logged } = vi.hoisted(() => ({
  findWorkspaceOfChat: vi.fn(),
  membershipWrite: vi.fn(),
  logged: { error: [] as string[] },
}));

vi.mock('@pagespace/lib/services/agent-workspaces/workspace-membership-store', () => ({
  findWorkspaceOfChat: (...args: unknown[]) => findWorkspaceOfChat(...args),
}));

vi.mock('@/lib/agent-workspaces/workspace-node-runtime', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/agent-workspaces/workspace-node-runtime');
  return { ...actual, applyWorkspaceMembershipWrite: (...args: unknown[]) => membershipWrite(...args) };
});

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: (message: string) => logged.error.push(message), warn: vi.fn(), info: vi.fn() } },
}));

const { expelAfterDelete } = await import('../agent-workspaces-runtime');

beforeEach(() => {
  vi.clearAllMocks();
  logged.error.length = 0;
  membershipWrite.mockResolvedValue({ status: 'ok', snapshot: { rev: 2, nodes: [], targets: [] }, changed: true });
});

describe('expelAfterDelete', () => {
  it('RE-RESOLVES the workspace rather than reusing the one the delete started from', async () => {
    // The finding this exists for. The window makes the thread HOMELESS, and a
    // homeless thread is claimable into ANY workspace — `claimConversationInSession`
    // proceeds on `home === null`, it does not require the caller to name the
    // one the thread came from. So the node written in the race is very often
    // in a DIFFERENT session than the delete expelled it from, and a second
    // expel aimed at the original would find `not_a_member`, report success,
    // and leave the pane exactly where the race put it.
    findWorkspaceOfChat.mockResolvedValue('ws-somewhere-else');

    await expelAfterDelete('conv-1', 'user-1');

    expect(membershipWrite).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-somewhere-else' }),
    );
  });

  it('writes NOTHING when the thread ended up homeless — the ordinary outcome', async () => {
    // Nothing raced, so the first expel already took the only node. There is no
    // workspace to address and no write to make.
    findWorkspaceOfChat.mockResolvedValue(null);

    await expelAfterDelete('conv-1', 'user-1');

    expect(membershipWrite).not.toHaveBeenCalled();
    expect(logged.error).toEqual([]);
  });

  it('SWALLOWS a failure instead of throwing it at a delete that already committed', async () => {
    // The other finding, and the more serious one. This runs after the row is
    // gone, so a throw would reach the route's outer catch and answer 500 for a
    // deletion that fully succeeded — skipping the compliance record, the
    // `data.delete` audit event and the broadcast that tells other clients the
    // thread is gone. A missed second expel leaves one stale pane; a missed
    // audit record is a compliance hole. It is reported, not raised.
    findWorkspaceOfChat.mockRejectedValue(new Error('lock timeout'));

    await expect(expelAfterDelete('conv-1', 'user-1')).resolves.toBeUndefined();
    expect(logged.error).toHaveLength(1);
    expect(logged.error[0]).toContain('Post-delete expel failed');
  });

  it('swallows a failure from the WRITE too, not only from the lookup', async () => {
    findWorkspaceOfChat.mockResolvedValue('ws-1');
    membershipWrite.mockRejectedValue(new Error('deadlock detected'));

    await expect(expelAfterDelete('conv-1', 'user-1')).resolves.toBeUndefined();
    expect(logged.error).toHaveLength(1);
  });
});

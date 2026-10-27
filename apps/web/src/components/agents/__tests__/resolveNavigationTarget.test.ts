/**
 * Pure function, no I/O — a click on a past-conversation row must land in
 * exactly the right place for that row's kind. A WORKSPACE-BOUND conversation
 * always wins the pane grid, whatever its `type`; everything else branches on
 * `type` with an exhaustive switch (compile-time guarded — see the `never`
 * check in the source) so a future `ConversationKind` value can't silently
 * misroute here.
 *
 * These cases all existed before and all passed, including the pane ones —
 * against a row shape that said `sessionId`, a field the server has never
 * sent. Every `workspaceId` below is now `Pick`ed from the shared wire
 * contract, so the fixtures can no longer describe a row that cannot arrive.
 * The end-to-end proof that the wire agrees lives in
 * `api/agent-workspaces/conversations/__tests__/wire-contract.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { resolveNavigationTarget, type PastConversationRow } from '../resolveNavigationTarget';

function row(overrides: Partial<PastConversationRow> = {}): PastConversationRow {
  return {
    conversationId: 'conv-1',
    type: 'global',
    agentPageId: null,
    workspaceId: null,
    driveId: null,
    ...overrides,
  };
}

describe('resolveNavigationTarget', () => {
  it('a workspace-bound conversation opens the pane grid, whatever its type', () => {
    const target = resolveNavigationTarget(
      row({ type: 'page', workspaceId: 'ses-1', agentPageId: 'agent-1', driveId: 'drive-1' }),
      undefined,
    );
    expect(target).toEqual({ kind: 'pane', sessionId: 'ses-1', conversationId: 'conv-1', agentId: 'agent-1' });
  });

  it('a workspace-bound page conversation whose page is currently inaccessible is unavailable, not a pane', () => {
    // The API masks `driveId` to null (never a real value for a live page)
    // specifically when it already checked and the requester can no longer
    // view that page. Opening the pane anyway would hit a 403 on the message
    // fetch and silently show nothing (review finding) — this must be caught
    // before the unconditional workspaceId branch below, not after it.
    const target = resolveNavigationTarget(
      row({ type: 'page', workspaceId: 'ses-1', agentPageId: 'agent-1', driveId: null }),
      undefined,
    );
    expect(target).toEqual({ kind: 'unavailable' });
  });

  it('an unbound page conversation is claimable — spawning a session is tried before falling back to its agent page', () => {
    const target = resolveNavigationTarget(
      row({ type: 'page', agentPageId: 'agent-1', driveId: 'drive-1' }),
      undefined,
    );
    expect(target).toEqual({
      kind: 'claimable',
      conversationId: 'conv-1',
      agentPageId: 'agent-1',
      driveId: 'drive-1',
      fallback: {
        kind: 'page',
        driveId: 'drive-1',
        pageId: 'agent-1',
        conversationId: 'conv-1',
      },
    });
  });

  it('a page conversation missing its agent/drive is unavailable — never falls back to the global assistant', () => {
    // The global assistant's loader reads the `messages` table; a page
    // conversation's content lives in `chat_messages`, which that loader can
    // never populate — routing there silently opened a blank, dead thread
    // (review finding). "Nowhere to go" must be honest, not a fake target.
    const target = resolveNavigationTarget(row({ type: 'page', agentPageId: null, driveId: null }), 'drive-current');
    expect(target).toEqual({ kind: 'unavailable' });
  });

  it('a client (API-managed) conversation is always unavailable — no in-app viewer exists for it', () => {
    const target = resolveNavigationTarget(row({ type: 'client', driveId: 'drive-9' }), undefined);
    expect(target).toEqual({ kind: 'unavailable' });
  });

  it('an unbound global conversation is claimable — its fallback is wherever the global assistant currently lives', () => {
    const target = resolveNavigationTarget(row({ type: 'global' }), 'drive-current');
    expect(target).toEqual({
      kind: 'claimable',
      conversationId: 'conv-1',
      agentPageId: null,
      driveId: 'drive-current',
      fallback: { kind: 'global', conversationId: 'conv-1', driveId: 'drive-current' },
    });
  });

  it('an unbound global conversation with no current drive scope falls back to the dashboard home', () => {
    const target = resolveNavigationTarget(row({ type: 'global' }), undefined);
    expect(target).toEqual({
      kind: 'claimable',
      conversationId: 'conv-1',
      agentPageId: null,
      driveId: null,
      fallback: { kind: 'global', conversationId: 'conv-1', driveId: null },
    });
  });

  it('a workspace-bound row still wins the pane grid even for a claimable-shaped type (branch-ordering regression guard)', () => {
    const target = resolveNavigationTarget(
      row({ type: 'global', workspaceId: 'ses-1' }),
      'drive-current',
    );
    expect(target).toEqual({ kind: 'pane', sessionId: 'ses-1', conversationId: 'conv-1', agentId: null });
  });
});

/**
 * Pure function, no I/O — a click on a past-conversation row must land in
 * exactly the right place for that row's kind. A session-bound conversation
 * always wins the pane grid, whatever its `type`; everything else branches on
 * `type` with an exhaustive switch (compile-time guarded — see the `never`
 * check in the source) so a future `ConversationKind` value can't silently
 * misroute here.
 */
import { describe, it, expect } from 'vitest';
import { resolveNavigationTarget, type PastConversationRow } from '../resolveNavigationTarget';

function row(overrides: Partial<PastConversationRow> = {}): PastConversationRow {
  return {
    conversationId: 'conv-1',
    type: 'global',
    agentPageId: null,
    sessionId: null,
    driveId: null,
    ...overrides,
  };
}

describe('resolveNavigationTarget', () => {
  it('a session-bound conversation opens the pane grid, whatever its type', () => {
    const target = resolveNavigationTarget(
      row({ type: 'page', sessionId: 'ses-1', agentPageId: 'agent-1', driveId: 'drive-1' }),
      undefined,
    );
    expect(target).toEqual({ kind: 'pane', sessionId: 'ses-1', conversationId: 'conv-1', agentId: 'agent-1' });
  });

  it('a plain page conversation navigates to its agent page, in its own drive', () => {
    const target = resolveNavigationTarget(
      row({ type: 'page', agentPageId: 'agent-1', driveId: 'drive-1' }),
      undefined,
    );
    expect(target).toEqual({
      kind: 'page',
      driveId: 'drive-1',
      pageId: 'agent-1',
      conversationId: 'conv-1',
      sessionId: null,
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

  it('a global conversation navigates wherever the global assistant currently lives', () => {
    const target = resolveNavigationTarget(row({ type: 'global' }), 'drive-current');
    expect(target).toEqual({ kind: 'global', conversationId: 'conv-1', driveId: 'drive-current' });
  });

  it('a global conversation with no current drive scope resolves to the dashboard home', () => {
    const target = resolveNavigationTarget(row({ type: 'global' }), undefined);
    expect(target).toEqual({ kind: 'global', conversationId: 'conv-1', driveId: null });
  });
});

/**
 * ONE LIST, NOT TWO (issue #2373).
 *
 * `/api/agent-workspaces` returned the flat conversation list AND the pane
 * grid, and `AgentsSidebar` chose between them with
 * `chatPanes ?? session.conversations`. An open workspace always has a grid, so
 * the pane branch always won — and a thread with no pane row was invisible,
 * however correct its conversation row.
 *
 * The measured production shape at the time of the bug is the first test
 * below: a workspace with more threads than panes. Placement is best-effort by
 * design and a thread created without `placeInGrid` is never placed at all, so
 * "more threads than panes" is a resting state the sidebar must render, not a
 * transient to wait out. (This PR also closes the sharpest source of it — the
 * old `spawn_session` gate skipped placement whenever the SDK supplied no
 * `toolCallId` — but the list must not depend on that having worked.)
 */
import { describe, it, expect } from 'vitest';
import type { PersistedColumnState } from '@pagespace/lib/agent-workspaces/contract';
import {
  annotateConversationsWithPanes,
  paneByConversationId,
} from '../annotate-conversation-panes';

const thread = (conversationId: string) => ({ conversationId, title: conversationId });

const chatPane = (id: string, targetId: string) => ({
  id,
  scope: { kind: 'chat' as const, targetId },
});

const grid = (columns: { id: string; panes: { id: string; scope: unknown }[] }[]) =>
  columns as unknown as PersistedColumnState[];

describe('annotateConversationsWithPanes', () => {
  it('keeps an UNPLACED thread in the list — the whole bug', () => {
    // Production, workspace tnmj4mu…: 3 threads, 2 panes. The thread titled
    // "hi" had no pane row and could not be seen or reached from the sidebar.
    const conversations = [thread('placed-a'), thread('hi'), thread('placed-b')];
    const annotated = annotateConversationsWithPanes(
      conversations,
      grid([
        { id: 'col-1', panes: [chatPane('pane-1', 'placed-a')] },
        { id: 'col-2', panes: [chatPane('pane-2', 'placed-b')] },
      ]),
    );

    expect(annotated.map((c) => c.conversationId)).toEqual(['placed-a', 'hi', 'placed-b']);
    expect(annotated.find((c) => c.conversationId === 'hi')?.pane).toBeNull();
  });

  it('annotates a placed thread with its pane, column and position', () => {
    const annotated = annotateConversationsWithPanes(
      [thread('c1'), thread('c2')],
      grid([{ id: 'col-1', panes: [chatPane('pane-1', 'c1'), chatPane('pane-2', 'c2')] }]),
    );

    expect(annotated[0].pane).toEqual({ paneId: 'pane-1', columnId: 'col-1', orderIndex: 0 });
    expect(annotated[1].pane).toEqual({ paneId: 'pane-2', columnId: 'col-1', orderIndex: 1 });
  });

  it('preserves the listing order rather than re-deriving it from the grid', () => {
    // The listing arrives newest-activity-first, which is what a sidebar reader
    // wants. Sorting by grid position would make a thread jump when someone
    // rearranged panes — geometry is the pane surface's concern, not the list's.
    const annotated = annotateConversationsWithPanes(
      [thread('newest'), thread('oldest')],
      grid([{ id: 'col-1', panes: [chatPane('p1', 'oldest'), chatPane('p2', 'newest')] }]),
    );

    expect(annotated.map((c) => c.conversationId)).toEqual(['newest', 'oldest']);
  });

  it('ignores panes that are not chat — a terminal or page pane must not shadow a thread', () => {
    const annotated = annotateConversationsWithPanes(
      [thread('c1')],
      grid([
        {
          id: 'col-1',
          panes: [
            { id: 'term', scope: { kind: 'terminal', targetId: 'sh_1' } },
            { id: 'page', scope: { kind: 'page', targetId: 'pg_1' } },
            { id: 'unbound', scope: null },
            chatPane('chat', 'c1'),
          ],
        },
      ]),
    );

    expect(annotated[0].pane).toEqual({ paneId: 'chat', columnId: 'col-1', orderIndex: 3 });
  });

  it('gives one row for a thread open in two panes — FIRST placement wins', () => {
    // Legal state: the same conversation in two panes of one grid. The sidebar
    // lists the THREAD, so it must not double-list.
    const annotated = annotateConversationsWithPanes(
      [thread('c1')],
      grid([
        { id: 'col-1', panes: [chatPane('first', 'c1')] },
        { id: 'col-2', panes: [chatPane('second', 'c1')] },
      ]),
    );

    expect(annotated).toHaveLength(1);
    expect(annotated[0].pane?.paneId).toBe('first');
  });

  it('handles a workspace with no grid at all — every thread unplaced', () => {
    for (const empty of [null, undefined, [] as PersistedColumnState[]]) {
      const annotated = annotateConversationsWithPanes([thread('c1'), thread('c2')], empty);
      expect(annotated).toHaveLength(2);
      expect(annotated.every((c) => c.pane === null)).toBe(true);
    }
  });

  it('tolerates a pane naming a conversation this workspace does not list', () => {
    // Two ways to reach this: a cross-workspace target (gated separately by the
    // label resolver), or a thread ranked past MAX_SESSION_CONVERSATIONS, since
    // the listing is capped at 100 by lastMessageAt. Either way the pane
    // annotates nothing and must NOT invent a row — synthesising one out of the
    // grid is the second source of truth this module deletes. Such a pane still
    // renders in the grid, which reads geometry from the store, not this list.
    const annotated = annotateConversationsWithPanes(
      [thread('mine')],
      grid([{ id: 'col-1', panes: [chatPane('p', 'someone-elses')] }]),
    );

    expect(annotated).toHaveLength(1);
    expect(annotated[0].pane).toBeNull();
  });

  it('does not mutate the conversations it is given', () => {
    const conversations = [thread('c1')];
    annotateConversationsWithPanes(conversations, grid([{ id: 'col', panes: [chatPane('p', 'c1')] }]));
    expect(conversations[0]).not.toHaveProperty('pane');
  });
});

describe('paneByConversationId', () => {
  it('indexes only chat panes, first wins', () => {
    const index = paneByConversationId(
      grid([
        { id: 'c1', panes: [chatPane('p1', 'conv-a'), { id: 't', scope: { kind: 'terminal', targetId: 'sh' } }] },
        { id: 'c2', panes: [chatPane('p2', 'conv-a'), chatPane('p3', 'conv-b')] },
      ]),
    );

    expect([...index.keys()].sort()).toEqual(['conv-a', 'conv-b']);
    expect(index.get('conv-a')?.paneId).toBe('p1');
  });
});

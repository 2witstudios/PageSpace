'use client';

// The /dm index: the Direct messages pane over the viewer's live conversations,
// and the DM ground's people. Both load through SWR; the pane's filter is local.

import { useState, type ReactNode } from 'react';
import { ageLabel } from '../../files/recents/recents';
import type { DirectThread } from '../message-model/message';
import { useDirectThreads } from '../use-messages/use-messages';
import { filterThreads } from './dm-index-model';
import { renderDmGround, renderDmIndexPane, type DmGroundState, type DmIndexState, type DmRowView } from './dm-index.render';
import { useMessageablePeople } from './use-dm-index';

export type DmIndexPaneProps = {
  /** `list` is the 300px stage-2 pane. */
  readonly variant: 'list' | 'tree';
  /** Close sidebar, from the shell. */
  readonly close: ReactNode;
  /** The conversation open as the object, if any. */
  readonly selectedConversationId: string | null;
};

const rowOf = (thread: DirectThread, selectedConversationId: string | null, now: Date): DmRowView => ({
  id: thread.id,
  // The other person's user row can be gone; the row still needs a name.
  name: thread.name || 'Unknown user',
  username: thread.username ?? null,
  avatarUrl: thread.avatarUrl,
  when: thread.lastMessageAt === null ? '' : ageLabel(thread.lastMessageAt, now),
  preview: thread.lastMessagePreview,
  unreadCount: thread.unreadCount,
  selected: thread.id === selectedConversationId,
});

/** The /dm index pane: the viewer's conversations, narrowed by the filter as it is typed. */
export function DmIndexPane({ variant, close, selectedConversationId }: DmIndexPaneProps) {
  const { threads, error, retry } = useDirectThreads();
  const [query, setQuery] = useState('');
  const now = new Date();
  const state: DmIndexState =
    threads !== undefined
      ? { status: 'ready', rows: filterThreads(threads, query).map((thread) => rowOf(thread, selectedConversationId, now)) }
      : error === undefined
        ? { status: 'loading' }
        : { status: 'error', retry };
  return renderDmIndexPane({ variant, close, state, query, onQueryChange: setQuery });
}

/** The DM ground's people: everyone the viewer can message, from GET /api/users/messageable. */
export function DmGround() {
  const { people, error, retry } = useMessageablePeople();
  const state: DmGroundState =
    people !== undefined
      ? people.length === 0
        ? { status: 'empty' }
        : { status: 'ready', people }
      : error === undefined
        ? { status: 'loading' }
        : { status: 'error', retry };
  return renderDmGround({ people: state });
}

'use client';

import type { ReactNode } from 'react';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { CONVERSATION_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { useDirectThreads } from '../use-messages/use-messages';

export type ConversationObjectProps = {
  readonly conversationId: string;
  /** The conversation's own view, drawn once it is known to be the viewer's. */
  readonly children: ReactNode;
};

/**
 * The DM object slot: the viewer's conversations (every page of them, the
 * same entry the messages list reads) are the authority on which ids are
 * theirs, so an id outside them draws not-found and a failed load a way to
 * ask again.
 */
export function ConversationObject({ conversationId, children }: ConversationObjectProps) {
  const { threads, error, retry } = useDirectThreads();
  if (threads === undefined) {
    return error === undefined
      ? renderLoadingState('Loading conversation…')
      : renderErrorState({ title: 'Could not load this conversation', retry });
  }
  if (!threads.some((thread) => thread.id === conversationId)) {
    return renderNotFound({ ...CONVERSATION_NOT_FOUND, homeHref: '/dm', linkLabel: 'Back to Messages' });
  }
  return children;
}

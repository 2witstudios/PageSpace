'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { fetchDirectThreads } from '../messages-api/messages-api';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { CONVERSATION_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { DIRECT_THREADS_KEY, useDirectThreads } from '../use-messages/use-messages';

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
  const { mutate } = useSWRConfig();
  const client = useApiClient();
  const [rechecked, setRechecked] = useState<string | null>(null);
  const missing = threads !== undefined && !threads.some((thread) => thread.id === conversationId);
  // A conversation just created (New message, a deep link) may not be in the cached list yet:
  // ask the server once before calling it not found.
  useEffect(() => {
    if (!missing || rechecked === conversationId) return;
    void fetchDirectThreads(client)
      .then((rows) => mutate(DIRECT_THREADS_KEY, rows, { revalidate: false }))
      .catch(() => undefined)
      .finally(() => setRechecked(conversationId));
  }, [missing, rechecked, conversationId, mutate, client]);
  if (threads === undefined) {
    return error === undefined
      ? renderLoadingState('Loading conversation…')
      : renderErrorState({ title: 'Could not load this conversation', retry });
  }
  if (missing && rechecked !== conversationId) return renderLoadingState('Loading conversation…');
  if (missing) {
    return renderNotFound({ ...CONVERSATION_NOT_FOUND, homeHref: '/dm', linkLabel: 'Back to Messages' });
  }
  return children;
}

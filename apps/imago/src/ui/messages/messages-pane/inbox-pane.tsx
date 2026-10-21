'use client';

import { useState } from 'react';
import { useInbox } from '../use-messages/use-messages';
import { inboxKeeps, inboxRowOf, type InboxFilter } from './inbox-rows';
import { renderInboxPane } from './inbox-pane.render';

/**
 * The Messages index's unified inbox: the viewer's channels and DMs, newest first, filtered
 * client-side by the Show control and the section's scope (the list is one load and one live
 * cache entry). A null drive is every drive.
 */
export function InboxPane({ driveId = null }: { readonly driveId?: string | null }) {
  const { threads, error, retry } = useInbox();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const onFilter = (next: InboxFilter) => setFilter(next);
  if (threads === undefined) {
    return renderInboxPane({ status: error === undefined ? 'loading' : 'error', filter, onFilter, retry, rows: [] });
  }
  const now = new Date();
  const rows = threads.filter((thread) => inboxKeeps(filter, thread, driveId)).map((thread) => inboxRowOf(thread, now));
  return renderInboxPane({ status: 'ready', filter, onFilter, retry, rows });
}

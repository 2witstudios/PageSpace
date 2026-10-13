'use client';

import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { usePathname } from 'next/navigation';
import { stageFor } from '../../frame/stage/stage';
import { useApiClient } from '@/api/swr-provider';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import SidebarActivityTab from '@/retained/components/layout/right-sidebar/ai-assistant/SidebarActivityTab';
import { renderIcon } from '../../components/icon/icon.render';
import { headControlClass } from '../../frame/controls/controls-class';
import { dispatch, transactions } from '../../store/transactions';
import { ageLabel } from '../../files/recents/recents';
import { chatPaths, deleteConversation } from '../chat-api/chat-api';
import { useAgentConversations } from '../use-chat-data/use-chat-data';
import { matchingConversations, streamingConversationIds } from './imago-history-model';
import { cn } from '../../cn';

const segmentClass = (on: boolean): string =>
  cn(
    'h-segment flex-1 cursor-pointer rounded-md border-0 px-3 text-xs font-medium',
    on ? 'bg-background text-ink shadow-1' : 'bg-transparent text-ink-muted',
  );

const searchClass = 'mx-3 mb-2 flex h-filter flex-none items-center gap-2 rounded-md bg-fill px-3 text-ink-faint';

const rowClass = (active: boolean): string =>
  cn(
    'group flex h-history-row w-full cursor-pointer items-center gap-2 rounded-md border-0 px-3 text-left text-sm',
    active ? 'bg-accent-soft text-ink' : 'bg-transparent text-ink hover:bg-fill',
  );

function ConversationHistory({ agentId, activeId }: { readonly agentId: string | null; readonly activeId: string | null }) {
  const client = useApiClient();
  const { conversations, revalidate } = useAgentConversations(agentId);
  const { data: streams } = useSWR<unknown>(chatPaths.activeStreams, { refreshInterval: 5000 });
  const generating = streamingConversationIds(streams);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const now = new Date();
  const rows = matchingConversations(conversations ?? [], query);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-1 pb-2 text-2xs font-medium tracking-wide text-ink-muted uppercase">Conversation History</div>
      <label className={searchClass}>
        {renderIcon({ name: 'search', size: 14 })}
        <input
          aria-label="Search conversations"
          placeholder="Search conversations..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
        />
      </label>
      <ul role="list" className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto px-2 pb-2">
        {rows.map((conversation) => (
          <li key={conversation.id} className="relative">
            <button type="button" className={rowClass(conversation.id === activeId)} onClick={() => dispatch(transactions.openConversation, conversation.id)}>
              {generating.has(conversation.id) ? <span className="size-live-dot flex-none rounded-round bg-accent" title="Still generating" /> : null}
              <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
              <span className="flex-none text-xs text-ink-faint">{generating.has(conversation.id) ? 'Generating…' : ageLabel(conversation.updatedAt, now)}</span>
            </button>
            {agentId === null ? null : confirming === conversation.id ? (
              <span className="absolute top-1 right-2 flex items-center gap-1 rounded-md bg-surface-raised px-1 text-xs shadow-1">
                Delete?
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent px-1 text-xs text-status-danger"
                  onClick={async () => {
                    setConfirming(null);
                    await deleteConversation(client, agentId, conversation.id);
                    await revalidate();
                  }}
                >
                  Delete
                </button>
                <button type="button" className="cursor-pointer border-0 bg-transparent px-1 text-xs text-ink-muted" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={`${headControlClass} absolute top-1 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                aria-label={`Delete ${conversation.title}`}
                onClick={() => setConfirming(conversation.id)}
              >
                {renderIcon({ name: 'trash', size: 13 })}
              </button>
            )}
          </li>
        ))}
        {rows.length === 0 ? <li className="px-3 py-2 text-sm text-ink-muted">{query.trim() === '' ? 'No conversations yet.' : 'No conversations match.'}</li> : null}
      </ul>
    </div>
  );
}

export type ImagoHistoryProps = { readonly agentId: string | null; readonly activeId: string | null };

/**
 * Imago's History view (C-Chat-History), in place of the thread: History lists this agent's
 * conversations (the open one marked, "Generating…" on any still streaming, Delete with a
 * confirm); Activity is the open page's activity, classic's activity tab reused, where an AI
 * change offers Undo. Opening a conversation returns to the thread.
 */
export function ImagoHistory({ agentId, activeId }: ImagoHistoryProps): ReactNode {
  const [view, setView] = useState<'history' | 'activity'>('history');
  // Activity is the open page's history; with no page open there is nothing to list.
  const stage = stageFor(usePathname() ?? '/');
  const openPageId = stage.object?.kind === 'page' ? stage.object.pageId : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Imago view" className="m-3 flex flex-none rounded-lg bg-fill p-px">
        <button type="button" role="tab" aria-selected={view === 'history'} className={segmentClass(view === 'history')} onClick={() => setView('history')}>
          History
        </button>
        <button type="button" role="tab" aria-selected={view === 'activity'} className={segmentClass(view === 'activity')} onClick={() => setView('activity')}>
          Activity
        </button>
      </div>
      {view === 'history' ? (
        <ConversationHistory agentId={agentId} activeId={activeId} />
      ) : (
        <div className="min-h-0 flex-1">
          {openPageId === null ? (
            <p className="p-4 text-sm text-ink-muted">Open a page to see its changes here.</p>
          ) : (
            <RetainedSurface>
              <SidebarActivityTab pageId={openPageId} />
            </RetainedSurface>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { useDriveStore } from '@/hooks/useDrive';
import { cn } from '@/lib/utils';
import EmptyState from './EmptyState';
import { resolveNavigationTarget, type ConversationKind } from './resolveNavigationTarget';

const PAGE_SIZE = 20;

interface ConversationRowDTO {
  conversationId: string;
  title: string | null;
  type: ConversationKind;
  agentPageId: string | null;
  pageTitle: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  sessionId: string | null;
  sessionName: string | null;
  sessionEndedAt: string | null;
  driveId: string | null;
}

interface ConversationsResponse {
  conversations: ConversationRowDTO[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
}

async function conversationsFetcher(url: string): Promise<ConversationsResponse> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to list conversations (${response.status})`);
  return response.json();
}

function buildKey(driveId: string | undefined, cursor: string | null): string {
  const params = new URLSearchParams();
  if (driveId) params.set('driveId', driveId);
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return `/api/agent-sessions/conversations?${params.toString()}`;
}

function rowLabel(row: ConversationRowDTO): string {
  if (row.title) return row.title;
  if (row.type === 'page') return row.pageTitle ?? 'Untitled conversation';
  if (row.type === 'global') return 'Global assistant chat';
  if (row.type === 'client') return 'API conversation';
  return 'Untitled conversation';
}

function rowSubtitle(row: ConversationRowDTO, showDrive: boolean, driveName: string | undefined): string {
  const parts: string[] = [];
  if (row.sessionId) {
    parts.push(row.sessionName ? row.sessionName : 'Session');
  } else if (row.type === 'page' && row.pageTitle) {
    parts.push(row.pageTitle);
  } else if (row.type === 'global') {
    parts.push('Global assistant');
  } else if (row.type === 'client') {
    parts.push('Created via API');
  }
  if (showDrive && driveName) parts.push(driveName);
  return parts.join(' · ');
}

/**
 * Default middle-panel view for the Agents surface: every past conversation
 * the requester owns, newest first, cursor-paginated. Each page is its own
 * SWR key (`cursor` is part of the key) — already-visited pages replay from
 * cache instead of refetching, and a new cursor's fetch can never race or
 * clobber a different cursor's cached state.
 */
export default function AgentsPastConversationsList({ driveId }: { driveId?: string }) {
  const router = useRouter();
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const { loadConversation } = useGlobalChatConversation();
  const drives = useDriveStore((state) => state.drives);

  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = cursorStack[pageIndex];

  const { data, error, isLoading } = useSWR<ConversationsResponse>(
    buildKey(driveId, cursor),
    conversationsFetcher,
    {
      revalidateOnFocus: false,
      // A failed Next/Prev fetch must not strand the user on a dead-end
      // error screen with no way back: keeping the last successful page's
      // data visible means the list and Prev/Next stay usable (Prev — the
      // one real escape hatch, since it replays an already-cached page)
      // while an inline notice covers the failed request, instead of the
      // whole view flipping to a full-screen error with no controls at all.
      keepPreviousData: true,
    },
  );

  const driveNameById = useMemo(() => new Map(drives.map((d) => [d.id, d.name])), [drives]);

  const handleRowClick = (row: ConversationRowDTO) => {
    const target = resolveNavigationTarget(row, driveId);
    switch (target.kind) {
      case 'pane':
        selectConversation({ sessionId: target.sessionId, conversationId: target.conversationId, agentId: target.agentId });
        return;
      case 'page':
        router.push(
          `/dashboard/${target.driveId}/${target.pageId}?conversationId=${encodeURIComponent(target.conversationId)}${
            target.sessionId ? `&sessionId=${encodeURIComponent(target.sessionId)}` : ''
          }`,
        );
        return;
      case 'global':
        void loadConversation(target.conversationId);
        router.push(
          target.driveId
            ? `/dashboard/${target.driveId}?c=${encodeURIComponent(target.conversationId)}`
            : `/dashboard?c=${encodeURIComponent(target.conversationId)}`,
        );
        return;
      case 'unavailable':
        toast.info("This conversation can't be opened here yet.");
        return;
    }
  };

  if (isLoading && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        Loading past conversations…
      </div>
    );
  }

  // A full-screen error only when there is truly nothing to show (the very
  // first fetch failed). A failed Next/Prev fetch, with `keepPreviousData`,
  // still has the last successful page in `data` — that's handled below by
  // an inline notice instead, so Prev/Next stay usable rather than stranding
  // the user on a dead end.
  if (error && !data) {
    return (
      <EmptyState
        title="Couldn't load past conversations"
        description="Something went wrong fetching your conversation history."
      />
    );
  }

  const conversations = data?.conversations ?? [];

  // True zero-history: keep the original blank-slate copy rather than an
  // empty list shell. Requires `!hasMore` too — the backend drops
  // now-inaccessible page rows from a drive-scoped listing, so a single
  // response CAN come back empty while more (visible) history still exists
  // a page or two further back; treating that as terminal would strand the
  // user with no way to reach it (review finding). `hasMore` defaults true
  // while `data` is still undefined, so this can't fire ahead of a real
  // answer from the server.
  if (conversations.length === 0 && pageIndex === 0 && !error && !(data?.pagination.hasMore ?? true)) {
    return (
      <EmptyState
        title="Select a session"
        description="Pick a session from the sidebar, or start a new one."
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {"Couldn't load this page — showing the last one loaded. Try Prev/Next again."}
        </div>
      )}
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {conversations.map((row) => (
          <button
            key={row.conversationId}
            type="button"
            onClick={() => handleRowClick(row)}
            className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors hover:bg-muted/50"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{rowLabel(row)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(row.lastMessageAt ?? row.createdAt), { addSuffix: true })}
              </span>
            </div>
            <div className="flex w-full items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {rowSubtitle(row, !driveId, row.driveId ? driveNameById.get(row.driveId) : undefined)}
              </span>
              {row.sessionEndedAt && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  Ended
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-2">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
          className={cn(
            'flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground',
          )}
        >
          <ChevronLeft className="size-4" /> Prev
        </button>
        <button
          type="button"
          disabled={!data?.pagination.hasMore}
          onClick={() => {
            const nextCursor = data?.pagination.nextCursor;
            if (!nextCursor) return;
            setCursorStack((stack) => {
              const next = stack.slice(0, pageIndex + 1);
              next.push(nextCursor);
              return next;
            });
            setPageIndex((i) => i + 1);
          }}
          className={cn(
            'flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground',
          )}
        >
          Next <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

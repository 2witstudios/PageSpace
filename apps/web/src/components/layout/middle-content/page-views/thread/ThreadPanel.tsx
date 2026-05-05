'use client';

/**
 * ThreadPanel
 *
 * Right-side panel that overlays the channel/DM message list to render a
 * one-level-deep thread. Generic across channels and DMs — the parent and
 * reply author resolution are injected by the mounting page so the panel
 * can stay agnostic of channel vs DM message shape.
 *
 * Routing:
 *   - Channel replies: GET/POST /api/channels/<contextId>/messages?parentId=<root>
 *   - DM replies:      GET/POST /api/messages/<contextId>?parentId=<root>
 *
 * Realtime: subscribes to the same channel/DM room the page already joined
 * and filters incoming new_message / new_dm_message by parentId === root.
 * The page is responsible for parent-footer reply-count updates;
 * thread_reply_count_updated is broadcast for that purpose elsewhere.
 *
 * The composer is a `MessageInput` configured with `parentId` + the
 * "Also send to channel/DM" toggle. Draft text is registered with
 * `useEditingStore` automatically by the underlying ChannelInput.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Bell, BellOff, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { StreamingMarkdown } from '@/components/ai/shared/chat/StreamingMarkdown';
import { MessageAttachment } from '@/components/shared/MessageAttachment';
import { MessageInput } from '@/components/shared/MessageInput';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { useThreadInboxStore } from '@/stores/useThreadInboxStore';
import type { AttachmentMeta, FileRelation } from '@/lib/attachment-utils';
import type { Reaction } from '@/components/shared/MessageReactions';
import { renderMessageParts, convertToMessageParts } from '@/components/messages/MessagePartRenderer';

export type ThreadSource = 'channel' | 'dm';

/**
 * Minimal reply shape used inside the panel — covers both channel and DM
 * message formats. `authorId` is `userId` for channel replies and `senderId`
 * for DM replies; the resolver maps it back to a display name + avatar.
 */
export interface ThreadReply {
  id: string;
  content: string;
  createdAt: string;
  authorId: string | null;
  authorName?: string | null;
  authorImage?: string | null;
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: FileRelation | null;
  reactions?: Reaction[];
  aiSenderName?: string | null;
  parentId?: string | null;
}

export interface ThreadAuthor {
  name: string;
  image: string | null;
}

export interface ThreadPanelProps {
  source: ThreadSource;
  contextId: string;
  parentId: string;
  currentUserId: string | null;
  /** Pre-rendered parent message header (page provides; preserves consistency with the main list) */
  parentSlot: ReactNode;
  /** Resolve a reply's author to a display name + avatar */
  resolveAuthor: (authorId: string | null | undefined, fallbackName?: string | null) => ThreadAuthor;
  /** Optional reply-count hint for the divider; the page knows it from the parent */
  replyCountHint?: number;
  onClose: () => void;
  /**
   * Test seam: lets tests inject a synchronous fetcher / SWR stub so the
   * harness does not need to wire up a global fetcher. Production callers
   * leave this undefined.
   */
  fetcher?: (url: string) => Promise<unknown>;
}

interface ListResponse {
  messages: RawReply[];
  hasMore: boolean;
  nextCursor: string | null;
  /**
   * Server-truth follow state for the requesting user. PR 5 added this so
   * the toggle reflects the persisted follower row, not just local state.
   * Older servers (pre-PR-5) omit the field; the panel treats `undefined` as
   * "not following yet known" and disables the toggle until first refresh.
   */
  isFollowing?: boolean;
}

interface RawReply {
  id: string;
  content: string;
  createdAt: string | Date;
  // channel shape
  userId?: string | null;
  user?: { id: string; name: string | null; image: string | null } | null;
  aiMeta?: { senderName: string } | null;
  // dm shape
  senderId?: string | null;
  // common
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: FileRelation | null;
  reactions?: Reaction[];
  parentId?: string | null;
}

const defaultFetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status}`);
  }
  return res.json();
};

const buildListUrl = (source: ThreadSource, contextId: string, parentId: string) =>
  source === 'channel'
    ? `/api/channels/${contextId}/messages?parentId=${encodeURIComponent(parentId)}`
    : `/api/messages/${contextId}?parentId=${encodeURIComponent(parentId)}`;

const buildPostUrl = (source: ThreadSource, contextId: string) =>
  source === 'channel'
    ? `/api/channels/${contextId}/messages`
    : `/api/messages/${contextId}`;

const normalizeReply = (raw: RawReply): ThreadReply => ({
  id: raw.id,
  content: raw.content,
  createdAt:
    typeof raw.createdAt === 'string' ? raw.createdAt : new Date(raw.createdAt).toISOString(),
  authorId: raw.userId ?? raw.senderId ?? null,
  authorName: raw.user?.name ?? raw.aiMeta?.senderName ?? null,
  authorImage: raw.user?.image ?? null,
  fileId: raw.fileId ?? null,
  attachmentMeta: raw.attachmentMeta ?? null,
  file: raw.file ?? null,
  reactions: raw.reactions ?? [],
  aiSenderName: raw.aiMeta?.senderName ?? null,
  parentId: raw.parentId ?? null,
});

export function ThreadPanel({
  source,
  contextId,
  parentId,
  currentUserId,
  parentSlot,
  resolveAuthor,
  replyCountHint,
  onClose,
  fetcher,
}: ThreadPanelProps) {
  const [draft, setDraft] = useState('');
  const [optimisticReplies, setOptimisticReplies] = useState<ThreadReply[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Optimistic follow state: starts undefined until SWR returns. Once we have
  // the server truth, optimistic updates lead the UI and the toggle reverts on
  // POST/DELETE failure (mirrors the reaction toggle pattern elsewhere).
  const [optimisticFollowing, setOptimisticFollowing] = useState<boolean | undefined>(undefined);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followInFlight, setFollowInFlight] = useState(false);

  // Clear the unread-thread badge for this root the moment the panel opens.
  // Subsequent fan-outs while the panel is open could re-bump the badge; the
  // page-side mount unsubscribes from the badge by closing the panel.
  const clearThreadBadge = useThreadInboxStore((state) => state.clearRoot);
  useEffect(() => {
    clearThreadBadge({ source, contextId, rootMessageId: parentId });
  }, [source, contextId, parentId, clearThreadBadge]);

  // Identity ref guards async work against thread switches: a send may
  // outlive the panel's current parentId if the user opens another thread
  // before the network call resolves. The ref reflects the live mount.
  const activeThreadKeyRef = useRef(`${source}:${contextId}:${parentId}`);
  useEffect(() => {
    activeThreadKeyRef.current = `${source}:${contextId}:${parentId}`;
  }, [source, contextId, parentId]);

  const listUrl = buildListUrl(source, contextId, parentId);
  const swrFetcher = useMemo(() => fetcher ?? defaultFetcher, [fetcher]);

  const { data, error, mutate, isLoading } = useSWR<ListResponse>(listUrl, swrFetcher);

  // Reset optimistic state when the open thread switches.
  useEffect(() => {
    setOptimisticReplies([]);
    setDraft('');
    setSubmitError(null);
    setOptimisticFollowing(undefined);
    setFollowError(null);
    setFollowInFlight(false);
  }, [parentId, contextId, source]);

  // Effective follow state: optimistic value wins while the toggle is
  // settling, otherwise the server-truth from SWR.
  const isFollowing = optimisticFollowing ?? data?.isFollowing ?? false;
  const followStateKnown = optimisticFollowing !== undefined || data?.isFollowing !== undefined;

  const buildFollowUrl = useCallback(() => {
    return source === 'channel'
      ? `/api/channels/${contextId}/messages/${parentId}/follow`
      : `/api/messages/${contextId}/${parentId}/follow`;
  }, [source, contextId, parentId]);

  const handleToggleFollow = useCallback(async () => {
    if (followInFlight) return;
    if (!followStateKnown) return;
    const next = !isFollowing;
    setOptimisticFollowing(next);
    setFollowError(null);
    setFollowInFlight(true);
    try {
      const res = await fetchWithAuth(buildFollowUrl(), {
        method: next ? 'POST' : 'DELETE',
      });
      if (!res.ok) {
        throw new Error(`Follow toggle failed: ${res.status}`);
      }
      // Refresh SWR so the server-truth replaces the optimistic value on the
      // next render; mutate without revalidate is enough since we already
      // know the new state.
      mutate(
        (current) => (current ? { ...current, isFollowing: next } : current),
        { revalidate: false },
      );
      setOptimisticFollowing(undefined);
    } catch (err) {
      console.error('Follow toggle failed', err);
      setOptimisticFollowing(!next);
      setFollowError('Could not update follow state');
    } finally {
      setFollowInFlight(false);
    }
  }, [followInFlight, followStateKnown, isFollowing, buildFollowUrl, mutate]);

  const socket = useSocketStore((state) => state.socket);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);

  // Realtime: append matching thread replies as they arrive on the room the
  // page already joined. Filtering by `parentId === root` keeps us scoped to
  // this thread; the page handles top-level rows on its side.
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected') return;
    const eventName = source === 'channel' ? 'new_message' : 'new_dm_message';

    const handler = (raw: RawReply) => {
      if (!raw || raw.parentId !== parentId) return;
      // The reply may have been seen via SWR already; mutate dedupes by id.
      mutate(
        (current) => {
          if (!current) return current;
          if (current.messages.some((m) => m.id === raw.id)) return current;
          return { ...current, messages: [...current.messages, raw] };
        },
        { revalidate: false },
      );
      // Drop ONE matching optimistic temp row when the server-confirmed
      // version arrives — content+author. Filtering by content alone would
      // wipe both rows when the user fires the same reply twice in a row.
      setOptimisticReplies((prev) => {
        const idx = prev.findIndex(
          (r) =>
            r.id.startsWith('temp-') &&
            r.content === raw.content &&
            (r.authorId ?? null) === (raw.userId ?? raw.senderId ?? null),
        );
        if (idx === -1) return prev;
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
    };

    const handleEdited = (data: { messageId: string; content: string; editedAt: string }) => {
      mutate(
        (current) => {
          if (!current) return current;
          let touched = false;
          const next = current.messages.map((m) => {
            if (m.id !== data.messageId) return m;
            touched = true;
            return { ...m, content: data.content };
          });
          return touched ? { ...current, messages: next } : current;
        },
        { revalidate: false },
      );
    };

    const handleDeleted = (data: { messageId: string }) => {
      mutate(
        (current) => {
          if (!current) return current;
          const next = current.messages.filter((m) => m.id !== data.messageId);
          return next.length === current.messages.length ? current : { ...current, messages: next };
        },
        { revalidate: false },
      );
    };

    socket.on(eventName, handler);
    socket.on('message_edited', handleEdited);
    socket.on('message_deleted', handleDeleted);
    return () => {
      socket.off(eventName, handler);
      socket.off('message_edited', handleEdited);
      socket.off('message_deleted', handleDeleted);
    };
  }, [socket, connectionStatus, source, parentId, mutate]);

  const replies = useMemo<ThreadReply[]>(() => {
    const fromServer = (data?.messages ?? []).map(normalizeReply);
    const seen = new Set(fromServer.map((r) => r.id));
    const merged = [...fromServer, ...optimisticReplies.filter((r) => !seen.has(r.id))];
    return merged;
  }, [data, optimisticReplies]);

  const handleSubmit = useCallback(
    async ({
      content,
      alsoSendToParent,
    }: {
      content: string;
      attachment?: unknown;
      alsoSendToParent: boolean;
    }) => {
      if (!currentUserId) return;
      // Snapshot the thread identity at send time so async results bound to
      // the OLD thread can't leak state into a thread the user switched to.
      const submitThreadKey = `${source}:${contextId}:${parentId}`;
      const tempId = `temp-${Date.now()}`;
      const optimistic: ThreadReply = {
        id: tempId,
        content,
        createdAt: new Date().toISOString(),
        authorId: currentUserId,
        parentId,
      };
      setOptimisticReplies((prev) => [...prev, optimistic]);
      setDraft('');
      setSubmitError(null);

      try {
        const response = (await post(buildPostUrl(source, contextId), {
          content,
          parentId,
          ...(alsoSendToParent ? { alsoSendToParent: true } : {}),
        })) as RawReply | { message: RawReply } | undefined;
        if (activeThreadKeyRef.current !== submitThreadKey) return;
        // Use the POST response to upsert the persisted reply directly.
        // Without this the temp row would stay stuck on "sending…" whenever
        // realtime broadcast is unavailable (e.g. INTERNAL_REALTIME_URL unset
        // or socket disconnected) — the websocket echo isn't the only signal.
        // Channel returns the reply at the top level; DM wraps it in
        // { message }.
        const persisted: RawReply | null = response
          ? 'message' in (response as { message?: RawReply })
            ? ((response as { message: RawReply }).message ?? null)
            : ((response as RawReply).id ? (response as RawReply) : null)
          : null;
        if (persisted) {
          mutate(
            (current) => {
              const base: ListResponse = current ?? { messages: [], hasMore: false, nextCursor: null };
              if (base.messages.some((m) => m.id === persisted.id)) return base;
              return { ...base, messages: [...base.messages, persisted] };
            },
            { revalidate: false },
          );
          // Remove the specific optimistic row we created for this send;
          // realtime echo may also fire and target the same tempId, but a
          // double-removal is a no-op.
          setOptimisticReplies((prev) => prev.filter((r) => r.id !== tempId));
        }
      } catch (err) {
        console.error('Thread reply failed', err);
        if (activeThreadKeyRef.current !== submitThreadKey) return;
        setOptimisticReplies((prev) => prev.filter((r) => r.id !== tempId));
        setDraft(content);
        setSubmitError('Failed to send reply');
      }
    },
    [currentUserId, source, contextId, parentId, mutate],
  );

  // Once we have a fetch response, count the actual visible rows (server +
  // optimistic temps); before the first response, fall back to the parent's
  // hint so the header doesn't flash "0 replies" then jump to N.
  const replyCount = data ? replies.length : replyCountHint ?? 0;

  return (
    <aside
      data-testid="thread-panel"
      aria-label="Thread"
      className="flex h-full w-full flex-col border-l border-border bg-background"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-semibold">Thread</span>
          {replyCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleFollow}
            disabled={followInFlight || !followStateKnown}
            aria-pressed={isFollowing}
            aria-label={isFollowing ? 'Unfollow thread' : 'Follow thread'}
            data-testid="thread-follow-toggle"
            title={
              followError
                ? followError
                : isFollowing
                ? 'Following — click to stop receiving inbox bumps'
                : 'Not following — click to receive inbox bumps for new replies'
            }
            className="gap-1.5 text-xs"
          >
            {isFollowing ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
            <span>{isFollowing ? 'Following' : 'Not following'}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close thread"
            data-testid="thread-panel-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 py-3">{parentSlot}</div>

        <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span data-testid="thread-divider-count">
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {error && (
          <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <div className="flex items-center justify-between gap-3">
              <span>Failed to load replies</span>
              <button
                type="button"
                onClick={() => mutate()}
                className="rounded px-2 py-1 text-xs hover:bg-destructive/20"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {isLoading && !error && (
          <div className="flex flex-col gap-3 px-4 py-2" data-testid="thread-loading">
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        )}

        {!isLoading && !error && replies.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            Start the thread
          </div>
        )}

        <div className="flex flex-col gap-3 px-4 pb-3">
          {replies.map((reply) => {
            const fallback = resolveAuthor(reply.authorId, reply.aiSenderName);
            const author: ThreadAuthor = {
              name: reply.authorName ?? fallback.name,
              image: reply.authorImage ?? fallback.image,
            };
            const isOwn = reply.authorId === currentUserId;
            const initial = author.name?.charAt(0).toUpperCase() ?? '?';
            return (
              <div key={reply.id} className="flex items-start gap-3" data-testid="thread-reply">
                <Avatar className="h-8 w-8 shrink-0">
                  {author.image && <AvatarImage src={author.image} />}
                  <AvatarFallback>{initial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{author.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(reply.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {isOwn && reply.id.startsWith('temp-') && (
                      <span className="text-xs italic text-muted-foreground">sending…</span>
                    )}
                  </div>
                  {reply.content && (
                    <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere]">
                      {source === 'channel' ? (
                        <StreamingMarkdown content={reply.content} isStreaming={false} />
                      ) : (
                        renderMessageParts(convertToMessageParts(reply.content))
                      )}
                    </div>
                  )}
                  {(reply.fileId || reply.attachmentMeta) && (
                    <MessageAttachment
                      message={{
                        fileId: reply.fileId ?? null,
                        attachmentMeta: reply.attachmentMeta ?? null,
                        file: reply.file ?? null,
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border p-3">
        {submitError && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {submitError}
          </div>
        )}
        <MessageInput
          source={source}
          contextId={contextId}
          parentId={parentId}
          showAlsoSendToParent
          value={draft}
          onChange={setDraft}
          onSubmit={handleSubmit}
          attachmentsEnabled={false}
          placeholder="Reply…"
        />
      </div>
    </aside>
  );
}

export default ThreadPanel;

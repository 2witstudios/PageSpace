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
import { Bell, BellOff, Check, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { StreamingMarkdown, addHardLineBreaks } from '@/components/ai/shared/chat/StreamingMarkdown';
import { MessageAttachment } from '@/components/shared/MessageAttachment';
import { MessageInput } from '@/components/shared/MessageInput';
import { MessageReactions, type Reaction } from '@/components/shared/MessageReactions';
import { MessageHoverToolbar } from '@/components/shared/MessageHoverToolbar';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { useThreadInboxStore } from '@/stores/useThreadInboxStore';
import type { AttachmentMeta, FileRelation } from '@/lib/attachment-utils';
import { renderMessageParts, convertToMessageParts } from '@/components/messages/MessagePartRenderer';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';

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
  sender?: { id: string; name: string | null; image: string | null } | null;
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
  // Channel rows carry { userId, user }; DM rows carry { senderId, sender }.
  // The two pairs travel together — a row never has `user` from one side and
  // `senderId` from the other. The fallback chains below assume that invariant.
  authorId: raw.userId ?? raw.senderId ?? null,
  authorName: raw.user?.name ?? raw.sender?.name ?? raw.aiMeta?.senderName ?? null,
  authorImage: raw.user?.image ?? raw.sender?.image ?? null,
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
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Clear the unread-thread badge for this root the moment the panel opens.
  // Subsequent fan-outs while the panel is open could re-bump the badge; the
  // page-side mount unsubscribes from the badge by closing the panel.
  const { isOpen: isKeyboardOpen, height: keyboardHeight } = useMobileKeyboard();
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
    setEditingReplyId(null);
    setEditContent('');
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
    // Snapshot the thread identity at the start of the request: if the user
    // switches to another thread before the response arrives, we must NOT
    // write the previous thread's optimistic state back into the store —
    // optimisticFollowing takes precedence over server data, so leaking it
    // across a thread switch would silently mislabel the new panel header.
    const submitThreadKey = activeThreadKeyRef.current;
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
      if (activeThreadKeyRef.current !== submitThreadKey) return;
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
      if (activeThreadKeyRef.current !== submitThreadKey) return;
      setOptimisticFollowing(!next);
      setFollowError('Could not update follow state');
    } finally {
      if (activeThreadKeyRef.current === submitThreadKey) {
        setFollowInFlight(false);
      }
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

    const handleReactionAdded = (payload: { messageId: string; reaction: Reaction }) => {
      mutate(
        (current) => {
          if (!current) return current;
          let touched = false;
          const next = current.messages.map((m) => {
            if (m.id !== payload.messageId) return m;
            if (m.reactions?.some((r) => r.id === payload.reaction.id)) return m;
            // Drop a matching optimistic temp reaction so the broadcast row
            // replaces it rather than duplicating.
            const filtered = (m.reactions ?? []).filter(
              (r) =>
                !(
                  r.id.startsWith('temp-') &&
                  r.emoji === payload.reaction.emoji &&
                  r.userId === payload.reaction.userId
                ),
            );
            touched = true;
            return { ...m, reactions: [...filtered, payload.reaction] };
          });
          return touched ? { ...current, messages: next } : current;
        },
        { revalidate: false },
      );
    };

    const handleReactionRemoved = (payload: {
      messageId: string;
      emoji: string;
      userId: string;
    }) => {
      mutate(
        (current) => {
          if (!current) return current;
          let touched = false;
          const next = current.messages.map((m) => {
            if (m.id !== payload.messageId) return m;
            touched = true;
            return {
              ...m,
              reactions: (m.reactions ?? []).filter(
                (r) => !(r.emoji === payload.emoji && r.userId === payload.userId),
              ),
            };
          });
          return touched ? { ...current, messages: next } : current;
        },
        { revalidate: false },
      );
    };

    socket.on(eventName, handler);
    socket.on('message_edited', handleEdited);
    socket.on('message_deleted', handleDeleted);
    socket.on('reaction_added', handleReactionAdded);
    socket.on('reaction_removed', handleReactionRemoved);
    return () => {
      socket.off(eventName, handler);
      socket.off('message_edited', handleEdited);
      socket.off('message_deleted', handleDeleted);
      socket.off('reaction_added', handleReactionAdded);
      socket.off('reaction_removed', handleReactionRemoved);
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

  // Per-reply mutation endpoints. Replies are ordinary message rows, so the
  // same id-addressed routes the main channel/DM views use apply here.
  const buildReplyUrl = useCallback(
    (id: string) =>
      source === 'channel'
        ? `/api/channels/${contextId}/messages/${id}`
        : `/api/messages/${contextId}/${id}`,
    [source, contextId],
  );

  const buildReactionUrl = useCallback(
    (id: string) =>
      source === 'channel'
        ? `/api/channels/${contextId}/messages/${id}/reactions`
        : `/api/messages/${contextId}/${id}/reactions`,
    [source, contextId],
  );

  const handleEditReply = useCallback(
    async (id: string, content: string) => {
      mutate(
        (current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((m) =>
                  m.id === id ? { ...m, content } : m,
                ),
              }
            : current,
        { revalidate: false },
      );
      setEditingReplyId(null);
      try {
        await patch(buildReplyUrl(id), { content });
      } catch (err) {
        console.error('Thread reply edit failed', err);
        setSubmitError('Failed to edit reply');
      }
    },
    [mutate, buildReplyUrl],
  );

  const handleDeleteReply = useCallback(
    async (id: string) => {
      mutate(
        (current) =>
          current
            ? { ...current, messages: current.messages.filter((m) => m.id !== id) }
            : current,
        { revalidate: false },
      );
      setOptimisticReplies((prev) => prev.filter((r) => r.id !== id));
      try {
        await del(buildReplyUrl(id), {});
      } catch (err) {
        console.error('Thread reply delete failed', err);
        setSubmitError('Failed to delete reply');
      }
    },
    [mutate, buildReplyUrl],
  );

  const handleAddReaction = useCallback(
    async (id: string, emoji: string) => {
      if (!currentUserId) return;
      const tempId = `temp-${Date.now()}`;
      const optimistic: Reaction = {
        id: tempId,
        emoji,
        userId: currentUserId,
        user: { id: currentUserId, name: null },
      };
      mutate(
        (current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((m) =>
                  m.id === id
                    ? { ...m, reactions: [...(m.reactions ?? []), optimistic] }
                    : m,
                ),
              }
            : current,
        { revalidate: false },
      );
      try {
        await post(buildReactionUrl(id), { emoji });
      } catch (err) {
        console.error('Thread reaction add failed', err);
        mutate(
          (current) =>
            current
              ? {
                  ...current,
                  messages: current.messages.map((m) =>
                    m.id === id
                      ? {
                          ...m,
                          reactions: (m.reactions ?? []).filter(
                            (r) => r.id !== tempId,
                          ),
                        }
                      : m,
                  ),
                }
              : current,
          { revalidate: false },
        );
      }
    },
    [currentUserId, mutate, buildReactionUrl],
  );

  const handleRemoveReaction = useCallback(
    async (id: string, emoji: string) => {
      if (!currentUserId) return;
      let removed: Reaction | undefined;
      mutate(
        (current) => {
          if (!current) return current;
          return {
            ...current,
            messages: current.messages.map((m) => {
              if (m.id !== id) return m;
              const next = (m.reactions ?? []).filter((r) => {
                if (r.emoji === emoji && r.userId === currentUserId) {
                  removed = r;
                  return false;
                }
                return true;
              });
              return { ...m, reactions: next };
            }),
          };
        },
        { revalidate: false },
      );
      try {
        await del(buildReactionUrl(id), { emoji });
      } catch (err) {
        console.error('Thread reaction remove failed', err);
        if (removed) {
          const restore = removed;
          mutate(
            (current) =>
              current
                ? {
                    ...current,
                    messages: current.messages.map((m) =>
                      m.id === id
                        ? { ...m, reactions: [...(m.reactions ?? []), restore] }
                        : m,
                    ),
                  }
                : current,
            { revalidate: false },
          );
        }
      }
    },
    [currentUserId, mutate, buildReactionUrl],
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
      <div className="flex items-center justify-between border-b border-border px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))]">
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

        <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
          {replies.map((reply) => {
            const fallback = resolveAuthor(reply.authorId, reply.aiSenderName);
            const author: ThreadAuthor = {
              name: reply.authorName ?? fallback.name,
              image: reply.authorImage ?? fallback.image,
            };
            const isOwn = reply.authorId === currentUserId;
            const isAi = !!reply.aiSenderName;
            const isTemp = reply.id.startsWith('temp-');
            const isEditing = editingReplyId === reply.id;
            // Mirror the main channel/DM list: actions only on persisted,
            // non-editing rows; owner controls only on the user's own
            // (non-AI) replies.
            const isReal = !isTemp && !isEditing;
            const showOwnerActions = isOwn && !isAi && isReal;
            const initial = author.name?.charAt(0).toUpperCase() ?? '?';
            return (
              <div
                key={reply.id}
                className="group/msg relative flex items-start gap-3"
                data-testid="thread-reply"
              >
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
                    {isOwn && isTemp && (
                      <span className="text-xs italic text-muted-foreground">sending…</span>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="mt-1 flex flex-col gap-2">
                      <textarea
                        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        rows={3}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (editContent.trim())
                              handleEditReply(reply.id, editContent.trim());
                          }
                          if (e.key === 'Escape') setEditingReplyId(null);
                        }}
                        autoFocus
                      />
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <button
                          onClick={() => {
                            if (editContent.trim())
                              handleEditReply(reply.id, editContent.trim());
                          }}
                          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-primary-foreground transition-colors hover:bg-primary/90"
                          type="button"
                        >
                          <Check size={12} /> Save
                        </button>
                        <button
                          onClick={() => setEditingReplyId(null)}
                          className="flex items-center gap-1 rounded px-2 py-1 transition-colors hover:bg-muted"
                          type="button"
                        >
                          <X size={12} /> Cancel
                        </button>
                        <span className="opacity-60">Enter to save · Esc to cancel</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      {reply.content && (
                        <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere]">
                          {source === 'channel' ? (
                            <StreamingMarkdown content={reply.aiSenderName ? reply.content : addHardLineBreaks(reply.content)} isStreaming={false} />
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
                    </>
                  )}
                  {currentUserId && !isTemp && (
                    <MessageReactions
                      reactions={reply.reactions ?? []}
                      currentUserId={currentUserId}
                      onAddReaction={(emoji) => handleAddReaction(reply.id, emoji)}
                      onRemoveReaction={(emoji) => handleRemoveReaction(reply.id, emoji)}
                    />
                  )}
                </div>
                {isReal && (
                  <MessageHoverToolbar
                    canReact={!!currentUserId}
                    canEdit={showOwnerActions}
                    canDelete={showOwnerActions}
                    canReplyInThread={false}
                    canQuoteReply={false}
                    reactions={reply.reactions}
                    currentUserId={currentUserId ?? undefined}
                    onAddReaction={(emoji) => handleAddReaction(reply.id, emoji)}
                    onRemoveReaction={(emoji) => handleRemoveReaction(reply.id, emoji)}
                    onEdit={() => {
                      setEditingReplyId(reply.id);
                      setEditContent(reply.content);
                    }}
                    onDelete={() => handleDeleteReply(reply.id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Composer */}
      <div
        className="border-t border-border p-3"
        style={{
          paddingBottom: isKeyboardOpen
            ? `calc(0.75rem + ${keyboardHeight}px)`
            : 'calc(0.75rem + var(--safe-bottom-offset, 0px))',
        }}
      >
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

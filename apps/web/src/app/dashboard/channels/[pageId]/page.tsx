'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Hash, ExternalLink, Lock, Check, X } from 'lucide-react';
import { MessageAttachment } from '@/components/shared/MessageAttachment';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/usePermissions';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai/ui/conversation';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { renderMessageParts, convertToMessageParts } from '@/components/messages/MessagePartRenderer';
import { type ChannelInputRef, type FileAttachment } from '@/components/layout/middle-content/page-views/channel/ChannelInput';
import { MessageInput } from '@/components/shared/MessageInput';
import { MessageDropZone } from '@/components/layout/middle-content/page-views/channel/MessageDropZone';
import { MessageReactions, type Reaction } from '@/components/shared/MessageReactions';
import { MessageHoverToolbar } from '@/components/shared/MessageHoverToolbar';
import MessageQuoteBlock from '@/components/messages/MessageQuoteBlock';
import type { QuotedMessageSnapshot } from '@pagespace/lib/services/quote-enrichment';
import { buildThreadPreview } from '@pagespace/lib/services/preview';
import { post, del, patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import {
  type AttachmentMeta,
  type FileRelation,
} from '@/lib/attachment-utils';
import { useThreadPanelStore } from '@/stores/useThreadPanelStore';
import { ThreadPanel } from '@/components/layout/middle-content/page-views/thread/ThreadPanel';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useMobile } from '@/hooks/useMobile';
import { formatDistanceToNow } from 'date-fns';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface MessageWithUser {
  id: string;
  pageId: string;
  content: string;
  userId: string;
  createdAt: Date;
  role: string;
  toolCalls: Record<string, unknown>;
  toolResults: Record<string, unknown>;
  user: {
    id: string;
    name: string;
    image: string | null;
  };
  reactions?: Reaction[];
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: FileRelation | null;
  aiMeta?: {
    senderType: 'global_assistant' | 'agent';
    senderName: string;
    agentPageId?: string;
  } | null;
  editedAt?: string | null;
  parentId?: string | null;
  replyCount?: number;
  lastReplyAt?: string | null;
  quotedMessageId?: string | null;
  quotedMessage?: QuotedMessageSnapshot | null;
}

interface Page {
  id: string;
  title: string;
  type: string;
  driveId: string;
  parentId: string | null;
}

export default function InboxChannelPage() {
  const params = useParams();
  const pageId = params.pageId as string;
  const { user } = useAuth();
  const [messages, setMessages] = useState<MessageWithUser[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const channelInputRef = useRef<ChannelInputRef>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  // Active inline quote-reply target. The snapshot is captured at quote-start
  // time so the optimistic insert can render the embed immediately, before
  // the server's enriched payload arrives.
  const [quotedMessageId, setQuotedMessageId] = useState<string | null>(null);
  const [activeQuotedSnapshot, setActiveQuotedSnapshot] = useState<QuotedMessageSnapshot | null>(null);
  const quotedPreview = activeQuotedSnapshot
    ? { authorName: activeQuotedSnapshot.authorName ?? 'Member', snippet: activeQuotedSnapshot.contentSnippet }
    : null;

  const socket = useSocketStore((state) => state.socket);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);
  const connect = useSocketStore((state) => state.connect);
  const { permissions } = usePermissions(pageId);
  const canEdit = permissions?.canEdit || false;
  const isMobile = useMobile();

  // Thread panel state — generic across channels and DMs.
  const threadPanelOpen = useThreadPanelStore((state) => state.open);
  const threadPanelSource = useThreadPanelStore((state) => state.source);
  const threadPanelContextId = useThreadPanelStore((state) => state.contextId);
  const threadPanelParentId = useThreadPanelStore((state) => state.parentId);
  const openThread = useThreadPanelStore((state) => state.openThread);
  const closeThread = useThreadPanelStore((state) => state.close);

  // Close any open thread when the user navigates between channels — the
  // store is global, so a stale parentId from a previous page would render
  // a panel against an unrelated message list otherwise.
  useEffect(() => {
    closeThread();
    // Also drop any active quote so a chip composed against a previous
    // channel cannot leak its messageId into the next channel's POST.
    setQuotedMessageId(null);
    setActiveQuotedSnapshot(null);
    // Only fire on context switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const isThreadVisible =
    threadPanelOpen &&
    threadPanelSource === 'channel' &&
    threadPanelContextId === pageId &&
    !!threadPanelParentId;

  // Fetch page details
  const { data: page, error: pageError } = useSWR<Page>(
    pageId ? `/api/pages/${pageId}` : null,
    fetcher
  );

  // Fetch messages
  useEffect(() => {
    const fetchMessages = async () => {
      if (!pageId) return;
      try {
        const res = await fetchWithAuth(`/api/channels/${pageId}/messages`);
        if (!res.ok) {
          throw new Error(`Failed to fetch messages: ${res.status}`);
        }
        const data = await res.json();
        setMessages(data.messages ?? data);
        setHasMore(data.hasMore ?? false);
        setNextCursor(data.nextCursor ?? null);

        // Mark channel as read when viewed
        post(`/api/channels/${pageId}/read`, {}).catch(() => {
          // Silently ignore errors - marking as read is not critical
        });
      } catch (error) {
        console.error('Error fetching messages:', error);
        setMessages([]);
      }
    };
    fetchMessages();
  }, [pageId]);

  // Connect to socket
  useEffect(() => {
    if (!user) return;
    if (connectionStatus === 'disconnected') {
      connect();
    }
  }, [user, connectionStatus, connect]);

  // Join channel and handle messages
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected' || !pageId) return;

    socket.emit('join_channel', pageId);

    const handleNewMessage = (message: MessageWithUser) => {
      // Thread replies live on the same room but belong to the panel — keep
      // them out of the top-level stream. The panel listens to the same
      // event and filters to its open root.
      if (message.parentId) return;
      setMessages((prev) => {
        if (prev.find((m) => m.id === message.id)) {
          return prev;
        }
        return [...prev.filter(m => !m.id.startsWith('temp-')), message];
      });
    };

    const handleThreadCountUpdated = (data: {
      rootId: string;
      replyCount: number;
      lastReplyAt: string;
    }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === data.rootId
            ? { ...m, replyCount: data.replyCount, lastReplyAt: data.lastReplyAt }
            : m,
        ),
      );
    };

    socket.on('new_message', handleNewMessage);
    socket.on('thread_reply_count_updated', handleThreadCountUpdated);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('thread_reply_count_updated', handleThreadCountUpdated);
    };
  }, [socket, connectionStatus, pageId]);

  const handleStartQuote = useCallback((m: MessageWithUser) => {
    if (m.id.startsWith('temp-')) return;
    setQuotedMessageId(m.id);
    setActiveQuotedSnapshot({
      id: m.id,
      authorId: m.user?.id ?? m.userId ?? null,
      authorName: m.aiMeta?.senderName || m.user?.name || 'Member',
      authorImage: m.user?.image ?? null,
      contentSnippet: buildThreadPreview(m.content),
      createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
      isActive: true,
    });
    channelInputRef.current?.focus();
  }, []);

  const clearQuote = useCallback(() => {
    setQuotedMessageId(null);
    setActiveQuotedSnapshot(null);
  }, []);

  const handleTopLevelSubmit = async ({
    content,
    attachment,
  }: {
    content: string;
    attachment?: FileAttachment;
  }) => {
    if (!user || !pageId) return;
    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }

    const activeQuoteId = quotedMessageId;
    const activeQuoteSnapshot = activeQuotedSnapshot;
    setInputValue('');
    channelInputRef.current?.clear();
    clearQuote();

    const attachmentMeta: AttachmentMeta | null = attachment
      ? {
          originalName: attachment.originalName,
          size: attachment.size,
          mimeType: attachment.mimeType,
          contentHash: attachment.contentHash,
        }
      : null;

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: MessageWithUser = {
      id: tempId,
      pageId,
      content,
      userId: user.id,
      createdAt: new Date(),
      role: 'user',
      toolCalls: {},
      toolResults: {},
      user: {
        id: user.id,
        name: user.name || 'You',
        image: null,
      },
      fileId: attachment?.id || null,
      attachmentMeta,
      quotedMessageId: activeQuoteId,
      quotedMessage: activeQuoteSnapshot ?? null,
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const body: { content: string; fileId?: string; attachmentMeta?: AttachmentMeta; quotedMessageId?: string } = {
        content,
      };
      if (attachment) {
        body.fileId = attachment.id;
        body.attachmentMeta = attachmentMeta!;
      }
      if (activeQuoteId) {
        body.quotedMessageId = activeQuoteId;
      }
      await post(`/api/channels/${pageId}/messages`, body);
    } catch (error) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      console.error('Error sending message:', error);
      toast.error('Failed to send message');
      setInputValue(content);
      // Restore the quote chip so the user's retry still carries the quote
      // they originally selected.
      if (activeQuoteId) {
        setQuotedMessageId(activeQuoteId);
        setActiveQuotedSnapshot(activeQuoteSnapshot);
      }
    }
  };

  const handleLoadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetchWithAuth(`/api/channels/${pageId}/messages?cursor=${encodeURIComponent(nextCursor)}`);
      if (!res.ok) throw new Error(`Failed to fetch older messages: ${res.status}`);
      const data = await res.json();
      const olderMessages: MessageWithUser[] = data.messages ?? data;
      setMessages((prev) => [...olderMessages, ...prev]);
      setHasMore(data.hasMore ?? false);
      setNextCursor(data.nextCursor ?? null);
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [pageId, nextCursor, loadingOlder]);

  const handleAddReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const optimisticReaction: Reaction = {
          id: `temp-${Date.now()}`,
          emoji,
          userId: user.id,
          user: { id: user.id, name: user.name || 'You' },
        };
        return {
          ...m,
          reactions: [...(m.reactions || []), optimisticReaction],
        };
      })
    );

    try {
      await post(`/api/channels/${pageId}/messages/${messageId}/reactions`, { emoji });
    } catch {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          return {
            ...m,
            reactions: (m.reactions || []).filter(
              (r) => !(r.emoji === emoji && r.userId === user.id)
            ),
          };
        })
      );
      toast.error('Failed to add reaction');
    }
  }, [pageId, user]);

  const handleRemoveReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;

    const removedReaction = messages
      .find((m) => m.id === messageId)
      ?.reactions?.find((r) => r.emoji === emoji && r.userId === user.id);

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        return {
          ...m,
          reactions: (m.reactions || []).filter(
            (r) => !(r.emoji === emoji && r.userId === user.id)
          ),
        };
      })
    );

    try {
      await del(`/api/channels/${pageId}/messages/${messageId}/reactions`, { emoji });
    } catch {
      if (removedReaction) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            return {
              ...m,
              reactions: [...(m.reactions || []), removedReaction],
            };
          })
        );
      }
      toast.error('Failed to remove reaction');
    }
  }, [pageId, user, messages]);

  // Handle real-time reaction updates
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected') return;

    const handleReactionAdded = (data: { messageId: string; reaction: Reaction }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== data.messageId) return m;
          const exists = m.reactions?.some((r) => r.id === data.reaction.id);
          if (exists) return m;
          const filteredReactions = (m.reactions || []).filter((r) => {
            if (!r.id.startsWith('temp-')) return true;
            return !(r.emoji === data.reaction.emoji && r.userId === data.reaction.userId);
          });
          return {
            ...m,
            reactions: [...filteredReactions, data.reaction],
          };
        })
      );
    };

    const handleReactionRemoved = (data: { messageId: string; emoji: string; userId: string }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== data.messageId) return m;
          return {
            ...m,
            reactions: (m.reactions || []).filter(
              (r) => !(r.emoji === data.emoji && r.userId === data.userId)
            ),
          };
        })
      );
    };

    socket.on('reaction_added', handleReactionAdded);
    socket.on('reaction_removed', handleReactionRemoved);

    return () => {
      socket.off('reaction_added', handleReactionAdded);
      socket.off('reaction_removed', handleReactionRemoved);
    };
  }, [socket, connectionStatus]);

  // Handle real-time edit/delete events
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected') return;

    const handleMessageEdited = (data: { messageId: string; content: string; editedAt: string }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === data.messageId ? { ...m, content: data.content, editedAt: data.editedAt } : m
        )
      );
    };

    const handleMessageDeleted = (data: { messageId: string }) => {
      setMessages((prev) => prev.filter((m) => m.id !== data.messageId));
    };

    socket.on('message_edited', handleMessageEdited);
    socket.on('message_deleted', handleMessageDeleted);

    return () => {
      socket.off('message_edited', handleMessageEdited);
      socket.off('message_deleted', handleMessageDeleted);
    };
  }, [socket, connectionStatus]);

  const handleEditMessage = useCallback(async (messageId: string, content: string) => {
    const editedAt = new Date().toISOString();
    setMessages((prev) =>
      prev.map((m) => m.id === messageId ? { ...m, content, editedAt } : m)
    );
    setEditingMessageId(null);
    try {
      await patch(`/api/channels/${pageId}/messages/${messageId}`, { content });
    } catch {
      toast.error('Failed to edit message');
    }
  }, [pageId]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await del(`/api/channels/${pageId}/messages/${messageId}`, {});
    } catch {
      toast.error('Failed to delete message');
    }
  }, [pageId]);

  if (pageError) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Hash className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Channel not found</h2>
          <p className="text-muted-foreground">This channel may have been deleted or you don&apos;t have access.</p>
        </div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-muted-foreground">Loading channel...</p>
        </div>
      </div>
    );
  }

  const threadParent = isThreadVisible
    ? messages.find((m) => m.id === threadPanelParentId) ?? null
    : null;

  const renderParentSlot = () => {
    if (!threadParent) {
      return (
        <div className="text-sm text-muted-foreground italic">
          Original message unavailable
        </div>
      );
    }
    const m = threadParent;
    const isAi = !!m.aiMeta;
    const displayName = isAi ? m.aiMeta!.senderName : m.user?.name;
    const avatarFallback = isAi
      ? m.aiMeta!.senderType === 'agent'
        ? 'A'
        : m.aiMeta!.senderName?.[0]
      : m.user?.name?.[0];
    return (
      <div className="flex items-start gap-3">
        <Avatar className="shrink-0">
          {!isAi && <AvatarImage src={m.user?.image || ''} />}
          <AvatarFallback>{avatarFallback}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{displayName}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(m.createdAt).toLocaleTimeString()}
            </span>
          </div>
          {m.content && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              {renderMessageParts(convertToMessageParts(m.content))}
            </div>
          )}
          <MessageAttachment message={m} />
        </div>
      </div>
    );
  };

  const resolveThreadAuthor = (authorId: string | null | undefined, fallbackName?: string | null) => {
    const fromList = messages.find((mm) => mm.userId === authorId);
    if (fromList?.user) {
      return { name: fromList.user.name, image: fromList.user.image };
    }
    if (authorId === user?.id) {
      return { name: user?.name ?? 'You', image: null };
    }
    return { name: fallbackName ?? 'Member', image: null };
  };

  const threadPanel = isThreadVisible && threadPanelParentId ? (
    <ThreadPanel
      source="channel"
      contextId={pageId}
      parentId={threadPanelParentId}
      currentUserId={user?.id ?? null}
      parentSlot={renderParentSlot()}
      resolveAuthor={resolveThreadAuthor}
      replyCountHint={threadParent?.replyCount}
      onClose={closeThread}
    />
  ) : null;

  return (
    <div className="flex h-full w-full">
    <MessageDropZone inputRef={channelInputRef} enabled={canEdit} className="flex flex-col h-full flex-1 min-w-0">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border p-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
              <Hash className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <h2 className="font-semibold">#{page.title}</h2>
              <p className="text-sm text-muted-foreground">Channel</p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/dashboard/${page.driveId}/${page.id}`}>
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in Drive
            </Link>
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-grow overflow-hidden relative">
        <Conversation className="h-full">
          <ConversationContent className="max-w-4xl mx-auto p-4">
            <div className="space-y-4">
              {hasMore && (
                <div className="flex justify-center py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLoadOlder}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? 'Loading...' : 'Load older messages'}
                  </Button>
                </div>
              )}
              {messages.map((m) => {
                const isAi = !!m.aiMeta;
                const displayName = isAi ? m.aiMeta!.senderName : m.user?.name;
                const aiLabel = isAi
                  ? m.aiMeta!.senderType === 'global_assistant'
                    ? 'global assistant'
                    : 'agent'
                  : null;
                const avatarFallback = isAi
                  ? m.aiMeta!.senderType === 'agent'
                    ? 'A'
                    : m.aiMeta!.senderName?.[0]
                  : m.user?.name?.[0];

                const isOwnMessage = !isAi && m.userId === user?.id;
                const replyCount = m.replyCount ?? 0;
                return (
                <div key={m.id} className="group/msg flex items-start gap-4">
                  <Avatar className="shrink-0">
                    {!isAi && <AvatarImage src={m.user?.image || ''} />}
                    <AvatarFallback>{avatarFallback}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col min-w-0 flex-1 relative">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{displayName}</span>
                      {aiLabel && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 font-medium">
                          {aiLabel}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(m.createdAt).toLocaleTimeString()}
                      </span>
                      {m.editedAt && (
                        <span className="text-xs text-muted-foreground italic">(Edited)</span>
                      )}
                    </div>
                    {editingMessageId === m.id ? (
                      <div className="mt-1 flex flex-col gap-2">
                        <textarea
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                          rows={3}
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              if (editContent.trim()) handleEditMessage(m.id, editContent.trim());
                            }
                            if (e.key === 'Escape') setEditingMessageId(null);
                          }}
                          autoFocus
                        />
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <button
                            onClick={() => { if (editContent.trim()) handleEditMessage(m.id, editContent.trim()); }}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            type="button"
                          >
                            <Check size={12} /> Save
                          </button>
                          <button
                            onClick={() => setEditingMessageId(null)}
                            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-muted transition-colors"
                            type="button"
                          >
                            <X size={12} /> Cancel
                          </button>
                          <span className="opacity-60">Enter to save · Esc to cancel</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        {(m.quotedMessage || m.quotedMessageId) && (
                          <MessageQuoteBlock quoted={m.quotedMessage ?? null} />
                        )}
                        {m.content ? (
                          <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere] min-w-0">
                            {renderMessageParts(convertToMessageParts(m.content))}
                          </div>
                        ) : null}
                      </>
                    )}
                    <MessageAttachment message={m} />
                    {replyCount > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          openThread({ source: 'channel', contextId: pageId, parentId: m.id })
                        }
                        data-testid={`thread-footer-${m.id}`}
                        className="mt-1 self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                        {m.lastReplyAt
                          ? ` · last reply ${formatDistanceToNow(new Date(m.lastReplyAt), { addSuffix: true })}`
                          : ''}
                      </button>
                    )}
                    {user && !m.id.startsWith('temp-') && (
                      <MessageReactions
                        reactions={m.reactions || []}
                        currentUserId={user.id}
                        onAddReaction={(emoji) => handleAddReaction(m.id, emoji)}
                        onRemoveReaction={(emoji) => handleRemoveReaction(m.id, emoji)}
                        canReact={permissions?.canView || false}
                      />
                    )}
                    {!m.id.startsWith('temp-') && editingMessageId !== m.id && (
                      <MessageHoverToolbar
                        canReact={permissions?.canView || false}
                        canEdit={isOwnMessage}
                        canDelete={isOwnMessage}
                        canReplyInThread={!m.id.startsWith('temp-')}
                        canQuoteReply={true}
                        reactions={m.reactions}
                        currentUserId={user?.id}
                        onAddReaction={(emoji) => handleAddReaction(m.id, emoji)}
                        onRemoveReaction={(emoji) => handleRemoveReaction(m.id, emoji)}
                        onQuoteReply={() => handleStartQuote(m)}
                        onEdit={() => { setEditingMessageId(m.id); setEditContent(m.content); }}
                        onDelete={() => handleDeleteMessage(m.id)}
                        onReplyInThread={() =>
                          openThread({ source: 'channel', contextId: pageId, parentId: m.id })
                        }
                      />
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </ConversationContent>
          <ConversationScrollButton className="z-20 bottom-6" />
        </Conversation>
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-border p-4">
        <div className="max-w-4xl mx-auto">
          {canEdit ? (
            <MessageInput
              ref={channelInputRef}
              source="channel"
              contextId={page.id}
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleTopLevelSubmit}
              driveId={page.driveId}
              attachmentsEnabled
              quotedPreview={quotedPreview}
              onClearQuote={clearQuote}
            />
          ) : (
            <Alert className="border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20">
              <Lock className="h-4 w-4" />
              <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                View-only access: {getPermissionErrorMessage('send', 'channel')}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </MessageDropZone>
    {threadPanel && !isMobile && (
      <div className="hidden md:flex w-[420px] shrink-0 h-full">
        {threadPanel}
      </div>
    )}
    {threadPanel && isMobile && (
      <Sheet open onOpenChange={(o) => { if (!o) closeThread(); }}>
        <SheetContent side="right" className="w-full sm:max-w-full p-0">
          <SheetTitle className="sr-only">Thread</SheetTitle>
          {threadPanel}
        </SheetContent>
      </Sheet>
    )}
    </div>
  );
}

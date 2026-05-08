'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/usePermissions';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TreePage, MessageWithUser } from '@/hooks/usePageTree';
import { StreamingMarkdown } from '@/components/ai/shared/chat/StreamingMarkdown';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai/ui/conversation';
import { type ChannelInputRef, type FileAttachment } from './ChannelInput';
import { MessageInput } from '@/components/shared/MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { MessageReactions, type Reaction } from '@/components/shared/MessageReactions';
import { MessageHoverToolbar } from '@/components/shared/MessageHoverToolbar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Lock, Check, X } from 'lucide-react';
import { MessageAttachment } from '@/components/shared/MessageAttachment';
import MessageQuoteBlock from '@/components/messages/MessageQuoteBlock';
import type { QuotedMessageSnapshot } from '@pagespace/lib/services/quote-enrichment';
import { buildThreadPreview } from '@pagespace/lib/services/preview';
import { post, del, patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { useThreadPanelStore } from '@/stores/useThreadPanelStore';
import { ThreadPanel } from '@/components/layout/middle-content/page-views/thread/ThreadPanel';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useMobile } from '@/hooks/useMobile';
import {
  type AttachmentMeta,
  type FileRelation,
} from '@/lib/attachment-utils';
import { isFirstInGroup } from '@/lib/messages/grouping';
import { formatDistanceToNow } from 'date-fns';

interface ChannelViewProps {
  page: TreePage;
}

// AI sender metadata for messages posted by AI tools
interface AiMeta {
  senderType: 'global_assistant' | 'agent';
  senderName: string;
  agentPageId?: string;
}

// Extended message type with reactions and file attachment
interface MessageWithReactions extends MessageWithUser {
  reactions?: Reaction[];
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: FileRelation | null;
  aiMeta?: AiMeta | null;
  editedAt?: string | null;
  quotedMessageId?: string | null;
  quotedMessage?: QuotedMessageSnapshot | null;
  replyCount?: number;
  lastReplyAt?: string | null;
}

function ChannelView({ page }: ChannelViewProps) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<MessageWithReactions[]>([]);
  const [inputValue, setInputValue] = useState('');
  const channelInputRef = useRef<ChannelInputRef>(null);

  // Use centralized socket store for proper authentication
  const socket = useSocketStore((state) => state.socket);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);
  const connect = useSocketStore((state) => state.connect);
  const threadPanelOpen = useThreadPanelStore((state) => state.open);
  const threadPanelSource = useThreadPanelStore((state) => state.source);
  const threadPanelContextId = useThreadPanelStore((state) => state.contextId);
  const threadPanelParentId = useThreadPanelStore((state) => state.parentId);
  const openThread = useThreadPanelStore((state) => state.openThread);
  const closeThread = useThreadPanelStore((state) => state.close);
  const isMobile = useMobile();

  const isThreadVisible =
    threadPanelOpen &&
    threadPanelSource === 'channel' &&
    threadPanelContextId === page.id &&
    !!threadPanelParentId;

  // Use the centralized permissions hook
  const { permissions } = usePermissions(page.id);
  const canEdit = permissions?.canEdit || false;
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  // Active inline quote-reply target. Set when the user picks "Quote reply" from
  // the message hover menu; cleared on successful send or via the chip's X.
  // The snapshot is captured at quote-start time so the optimistic insert can render the
  // embed immediately, before the server's enriched response arrives.
  const [quotedMessageId, setQuotedMessageId] = useState<string | null>(null);
  const [activeQuotedSnapshot, setActiveQuotedSnapshot] = useState<QuotedMessageSnapshot | null>(null);
  const quotedPreview = activeQuotedSnapshot
    ? { authorName: activeQuotedSnapshot.authorName ?? 'Member', snippet: activeQuotedSnapshot.contentSnippet }
    : null;

  // Close any open thread when navigating between channels — `useThreadPanelStore`
  // is global, so a stale parentId from a previous page would otherwise reappear
  // when CenterPanel reuses ChannelView without a per-page key.
  useEffect(() => {
    closeThread();
    setQuotedMessageId(null);
    setActiveQuotedSnapshot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  useEffect(() => {
    const fetchMessages = async () => {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages`);
      const data = await res.json();
      setMessages(data.messages ?? data);
      setHasMore(data.hasMore ?? false);
      setNextCursor(data.nextCursor ?? null);

      // Mark channel as read when viewed
      post(`/api/channels/${page.id}/read`, {}).catch(() => {
        // Silently ignore errors - marking as read is not critical
      });
    };
    fetchMessages();
  }, [page.id]);

  // Connect to socket store when user is available
  useEffect(() => {
    if (!user) return;

    // Ensure socket is connected
    if (connectionStatus === 'disconnected') {
      connect();
    }
  }, [user, connectionStatus, connect]);

  // Join channel and handle messages when socket is connected
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected') return;

    socket.emit('join_channel', page.id);

    const handleNewMessage = (message: MessageWithUser & { parentId?: string | null }) => {
      // Thread replies belong to the panel; the main channel stream renders
      // only top-level messages. PR 4 will surface parentId-bearing rows in
      // the ThreadPanel; until then, drop them here so the thread API does
      // not pollute the live channel view of older clients.
      if (message.parentId) return;
      setMessages((prev) => {
        // If the message is already in the list, don't add it again.
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
  }, [socket, connectionStatus, page.id]);

  const handleStartQuote = useCallback((m: MessageWithReactions) => {
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

  const handleSubmit = async (
    content: string,
    attachment?: FileAttachment,
    activeQuoteId?: string | null,
    activeQuoteSnapshot?: QuotedMessageSnapshot | null,
  ) => {
    if (!user) return;

    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }

    const messageContent = typeof content === 'string' ? content : JSON.stringify(content);

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: MessageWithReactions = {
      id: tempId,
      pageId: page.id,
      content: messageContent,
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
      // Include attachment info in optimistic message
      fileId: attachment?.id || null,
      attachmentMeta: attachment ? {
        originalName: attachment.originalName,
        size: attachment.size,
        mimeType: attachment.mimeType,
        contentHash: attachment.contentHash,
      } : null,
      quotedMessageId: activeQuoteId ?? null,
      // Carry the snapshot through the optimistic phase so the embed renders
      // immediately; the server's enriched payload will replace it.
      quotedMessage: activeQuoteSnapshot ?? null,
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      await post(`/api/channels/${page.id}/messages`, {
        content: messageContent,
        fileId: attachment?.id,
        attachmentMeta: attachment ? {
          originalName: attachment.originalName,
          size: attachment.size,
          mimeType: attachment.mimeType,
          contentHash: attachment.contentHash,
        } : undefined,
        quotedMessageId: activeQuoteId ?? undefined,
      });

      // The new message will be received via the socket connection,
      // which will replace the optimistic one.
    } catch (error) {
      // If the API call fails, remove the optimistic message
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      console.error('Error sending message:', error);
      toast.error('Failed to send message. Please try again.');
      // Restore the quote chip so the user's retry still carries the quote
      // they originally selected; without this the failed-send recovery would
      // silently strip the quote context.
      if (activeQuoteId) {
        setQuotedMessageId(activeQuoteId);
        setActiveQuotedSnapshot(activeQuoteSnapshot ?? null);
      }
    }
  };

  const handleTopLevelSubmit = ({
    content,
    attachment,
  }: {
    content: string;
    attachment?: FileAttachment;
  }) => {
    if (!content.trim() && !attachment) return;
    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }
    const activeQuoteId = quotedMessageId;
    const activeQuoteSnapshot = activeQuotedSnapshot;
    setInputValue('');
    channelInputRef.current?.clear();
    clearQuote();
    handleSubmit(content, attachment, activeQuoteId, activeQuoteSnapshot);
  };

  // Load older messages when scrolling to top
  const handleLoadOlder = useCallback(async () => {
    if (!hasMore || loadingOlder || !nextCursor) return;
    setLoadingOlder(true);
    try {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages?cursor=${encodeURIComponent(nextCursor)}`);
      const data = await res.json();
      const olderMessages: MessageWithReactions[] = data.messages ?? data;
      setMessages((prev) => [...olderMessages, ...prev]);
      setHasMore(data.hasMore ?? false);
      setNextCursor(data.nextCursor ?? null);
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [page.id, hasMore, loadingOlder, nextCursor]);

  // Reaction handlers
  const handleAddReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;

    // Optimistic update
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
      await post(`/api/channels/${page.id}/messages/${messageId}/reactions`, { emoji });
    } catch {
      // Revert optimistic update on error
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
  }, [page.id, user]);

  const handleRemoveReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;

    // Capture removedReaction inside the updater so messages isn't a dependency
    let removedReaction: Reaction | undefined;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        removedReaction ??= m.reactions?.find(
          (r) => r.emoji === emoji && r.userId === user.id
        );
        return {
          ...m,
          reactions: (m.reactions || []).filter(
            (r) => !(r.emoji === emoji && r.userId === user.id)
          ),
        };
      })
    );

    try {
      await del(`/api/channels/${page.id}/messages/${messageId}/reactions`, { emoji });
    } catch {
      // Revert optimistic update on error
      if (removedReaction) {
        const reactionToRestore = removedReaction;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            return {
              ...m,
              reactions: [...(m.reactions || []), reactionToRestore],
            };
          })
        );
      }
      toast.error('Failed to remove reaction');
    }
  }, [page.id, user]);

  // Handle real-time reaction updates
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected') return;

    const handleReactionAdded = (data: { messageId: string; reaction: Reaction }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== data.messageId) return m;
          // Avoid duplicates - check if this exact reaction already exists
          const exists = m.reactions?.some((r) => r.id === data.reaction.id);
          if (exists) return m;
          // Only remove the specific temp reaction that matches this confirmed reaction
          // (same emoji and userId), keep other temp reactions intact
          const filteredReactions = (m.reactions || []).filter((r) => {
            if (!r.id.startsWith('temp-')) return true;
            // Remove temp reaction only if it matches the confirmed reaction
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
      await patch(`/api/channels/${page.id}/messages/${messageId}`, { content });
    } catch {
      toast.error('Failed to edit message');
    }
  }, [page.id]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await del(`/api/channels/${page.id}/messages/${messageId}`, {});
    } catch {
      toast.error('Failed to delete message');
    }
  }, [page.id]);

  const threadParent = isThreadVisible
    ? messages.find((mm) => mm.id === threadPanelParentId) ?? null
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
              <StreamingMarkdown content={m.content} isStreaming={false} />
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
      return { name: fromList.user.name ?? fallbackName ?? 'Member', image: fromList.user.image };
    }
    if (authorId === user?.id) {
      return { name: user?.name ?? 'You', image: null };
    }
    return { name: fallbackName ?? 'Member', image: null };
  };

  const threadPanel = isThreadVisible && threadPanelParentId ? (
    <ThreadPanel
      source="channel"
      contextId={page.id}
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
        <div className="flex-grow overflow-hidden relative">
          <Conversation className="h-full">
            <ConversationContent className="max-w-4xl mx-auto p-4">
                    {hasMore && (
                      <div className="flex justify-center py-2">
                        <button
                          onClick={handleLoadOlder}
                          disabled={loadingOlder}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        >
                          {loadingOlder ? 'Loading...' : 'Load older messages'}
                        </button>
                      </div>
                    )}
                    {messages.map((m, i) => {
                        const isAi = !!m.aiMeta;
                        const displayName = isAi ? m.aiMeta!.senderName : m.user?.name;
                        const aiLabel = isAi
                          ? m.aiMeta!.senderType === 'global_assistant'
                            ? 'global assistant'
                            : 'agent'
                          : null;
                        const avatarFallback = isAi
                          ? m.aiMeta!.senderType === 'agent' ? 'A' : m.aiMeta!.senderName?.[0]
                          : m.user?.name?.[0];
                        const isOwnMessage = !isAi && m.userId === user?.id;
                        const authorKey = isAi ? `ai:${m.aiMeta!.senderName}` : m.userId ?? '';
                        const previous = messages[i - 1];
                        const isFirst = isFirstInGroup(
                          { authorKey, createdAt: m.createdAt },
                          previous
                            ? {
                                authorKey: previous.aiMeta
                                  ? `ai:${previous.aiMeta.senderName}`
                                  : previous.userId ?? '',
                                createdAt: previous.createdAt,
                              }
                            : undefined,
                        );
                        const rowSpacing = i === 0 ? '' : isFirst ? 'mt-4' : 'mt-0.5';
                        const isRealMessage = !m.id.startsWith('temp-') && editingMessageId !== m.id;
                        const showOwnerActions = isOwnMessage && isRealMessage;
                        const replyCount = m.replyCount ?? 0;
                        return (
                        <div key={m.id} className={`group/msg flex items-start gap-4 ${rowSpacing}`}>
                            {isFirst ? (
                              <Avatar className="shrink-0">
                                  {!isAi && <AvatarImage src={m.user?.image || ''} />}
                                  <AvatarFallback>{avatarFallback}</AvatarFallback>
                              </Avatar>
                            ) : (
                              <div className="size-8 shrink-0 relative" aria-hidden>
                                <span className="absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground opacity-0 group-hover/msg:opacity-100 transition-opacity tabular-nums">
                                  {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                            )}
                            <div className="flex flex-col min-w-0 flex-1 relative">
                                {isFirst && (
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
                                )}
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
                                    {m.content && (
                                      <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere] min-w-0">
                                        <StreamingMarkdown content={m.content} isStreaming={false} />
                                      </div>
                                    )}
                                    {!isFirst && m.editedAt && (
                                      <span className="text-xs text-muted-foreground italic">(Edited)</span>
                                    )}
                                  </>
                                )}
                                <MessageAttachment message={m} />
                                {replyCount > 0 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openThread({ source: 'channel', contextId: page.id, parentId: m.id })
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
                                {isRealMessage && (
                                  <MessageHoverToolbar
                                    canReact={permissions?.canView || false}
                                    canEdit={showOwnerActions}
                                    canDelete={showOwnerActions}
                                    canReplyInThread={!m.id.startsWith('temp-')}
                                    canQuoteReply={true}
                                    reactions={m.reactions}
                                    currentUserId={user?.id}
                                    className={!isFirst ? 'top-0' : undefined}
                                    onAddReaction={(emoji) => handleAddReaction(m.id, emoji)}
                                    onRemoveReaction={(emoji) => handleRemoveReaction(m.id, emoji)}
                                    onQuoteReply={() => handleStartQuote(m)}
                                    onEdit={() => { setEditingMessageId(m.id); setEditContent(m.content); }}
                                    onDelete={() => handleDeleteMessage(m.id)}
                                    onReplyInThread={() =>
                                      openThread({ source: 'channel', contextId: page.id, parentId: m.id })
                                    }
                                  />
                                )}
                            </div>
                        </div>
                        );
                    })}
            </ConversationContent>
            <ConversationScrollButton className="z-20 bottom-6" />
          </Conversation>
        </div>
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
                placeholder="Type a message... (use @ to mention, supports **markdown**)"
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

// Only re-render when the channel identity changes.
// Update this comparator if additional page fields are consumed.
export default memo(
  ChannelView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.driveId === nextProps.page.driveId
);

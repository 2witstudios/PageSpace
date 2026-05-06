'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai/ui/conversation';
import { type ChannelInputRef } from '@/components/layout/middle-content/page-views/channel/ChannelInput';
import { MessageInput } from '@/components/shared/MessageInput';
import { MessageDropZone } from '@/components/layout/middle-content/page-views/channel/MessageDropZone';
import type { FileAttachment } from '@/hooks/useAttachmentUpload';
import { MessageAttachment } from '@/components/shared/MessageAttachment';
import { MessageReactions, type Reaction } from '@/components/shared/MessageReactions';
import { MessageHoverToolbar } from '@/components/shared/MessageHoverToolbar';
import { renderMessageParts, convertToMessageParts } from '@/components/messages/MessagePartRenderer';
import type { AttachmentMeta } from '@/lib/attachment-utils';
import useSWR from 'swr';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { post, patch, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Check, X } from 'lucide-react';
import MessageQuoteBlock from '@/components/messages/MessageQuoteBlock';
import type { QuotedMessageSnapshot } from '@pagespace/lib/services/quote-enrichment';
import { buildThreadPreview } from '@pagespace/lib/services/preview';
import { useThreadPanelStore } from '@/stores/useThreadPanelStore';
import { ThreadPanel } from '@/components/layout/middle-content/page-views/thread/ThreadPanel';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useMobile } from '@/hooks/useMobile';
import { formatDistanceToNow } from 'date-fns';
import { isFirstInGroup } from '@/lib/messages/grouping';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  isRead: boolean;
  readAt: string | null;
  isEdited: boolean;
  editedAt: string | null;
  createdAt: string;
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  reactions?: Reaction[];
  parentId?: string | null;
  replyCount?: number;
  lastReplyAt?: string | null;
  quotedMessageId?: string | null;
  quotedMessage?: QuotedMessageSnapshot | null;
}

interface DmConversation {
  id: string;
  participant1Id: string;
  participant2Id: string;
  otherUser: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

const isMatchingOptimisticMessage = (optimistic: Message, message: Message) =>
  optimistic.id.startsWith('temp-') &&
  optimistic.conversationId === message.conversationId &&
  optimistic.senderId === message.senderId &&
  optimistic.content === message.content &&
  (optimistic.fileId ?? null) === (message.fileId ?? null);

const reconcileMessage = (prev: Message[], message: Message) => {
  const optimisticIndex = prev.findIndex((m) => isMatchingOptimisticMessage(m, message));

  if (optimisticIndex !== -1) {
    return prev.reduce<Message[]>((next, current, index) => {
      if (current.id === message.id) return next;
      next.push(index === optimisticIndex ? message : current);
      return next;
    }, []);
  }

  if (prev.find((m) => m.id === message.id)) return prev;
  return [...prev, message];
};

export default function InboxDMPage() {
  const params = useParams();
  const conversationId = params.conversationId as string;
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  // Active inline quote-reply target. The snapshot is captured at quote-start time
  // so the optimistic insert can render the embed immediately, before the server's
  // enriched payload arrives.
  const [quotedMessageId, setQuotedMessageId] = useState<string | null>(null);
  const [activeQuotedSnapshot, setActiveQuotedSnapshot] = useState<QuotedMessageSnapshot | null>(null);
  const quotedPreview = activeQuotedSnapshot
    ? { authorName: activeQuotedSnapshot.authorName ?? 'Member', snippet: activeQuotedSnapshot.contentSnippet }
    : null;
  const chatInputRef = useRef<ChannelInputRef>(null);
  const socket = useSocket();
  const isMobile = useMobile();

  const threadPanelOpen = useThreadPanelStore((state) => state.open);
  const threadPanelSource = useThreadPanelStore((state) => state.source);
  const threadPanelContextId = useThreadPanelStore((state) => state.contextId);
  const threadPanelParentId = useThreadPanelStore((state) => state.parentId);
  const openThread = useThreadPanelStore((state) => state.openThread);
  const closeThread = useThreadPanelStore((state) => state.close);

  // Close any open thread when navigating between conversations.
  useEffect(() => {
    closeThread();
    // Also drop any active quote so a chip composed against a previous DM
    // cannot leak its messageId into the next conversation's POST.
    setQuotedMessageId(null);
    setActiveQuotedSnapshot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const isThreadVisible =
    threadPanelOpen &&
    threadPanelSource === 'dm' &&
    threadPanelContextId === conversationId &&
    !!threadPanelParentId;

  // Fetch conversation details (single conversation, not the full list)
  const { data: conversationData } = useSWR<{ conversation: DmConversation }>(
    conversationId ? `/api/messages/conversations/${conversationId}` : null,
    fetcher
  );

  const conversation = conversationData?.conversation;

  // Fetch messages
  const { data: messagesData } = useSWR<{ messages: Message[] }>(
    conversationId ? `/api/messages/${conversationId}` : null,
    fetcher,
    {
      refreshInterval: 0,
    }
  );

  useEffect(() => {
    if (messagesData?.messages) {
      setMessages(messagesData.messages);
    }
  }, [messagesData]);

  // Socket room join and updates
  useEffect(() => {
    if (!user || !conversationId || !socket) return;

    socket.emit('join_dm_conversation', conversationId);

    const handleNewMessage = (message: Message) => {
      // Thread replies belong to the panel; the main DM stream renders only
      // top-level messages. PR 4 will surface parentId-bearing rows in the
      // ThreadPanel; until then, drop them here so the thread API does not
      // pollute the live DM view of older clients.
      if (message.parentId) return;
      if (message.conversationId === conversationId) {
        setMessages((prev) => reconcileMessage(prev, message));

        if (message.senderId !== user.id) {
          patch(`/api/messages/${conversationId}`);
        }
      }
    };

    const handleReactionAdded = (data: { messageId: string; reaction: Reaction }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== data.messageId) return m;
          const exists = m.reactions?.some((r) => r.id === data.reaction.id);
          if (exists) return m;
          // Drop any optimistic temp reaction the local user wrote for this same
          // (emoji, userId) so the broadcast row replaces it without duplicating.
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

    socket.on('new_dm_message', handleNewMessage);
    socket.on('reaction_added', handleReactionAdded);
    socket.on('reaction_removed', handleReactionRemoved);
    socket.on('thread_reply_count_updated', handleThreadCountUpdated);

    return () => {
      socket.off('new_dm_message', handleNewMessage);
      socket.off('reaction_added', handleReactionAdded);
      socket.off('reaction_removed', handleReactionRemoved);
      socket.off('thread_reply_count_updated', handleThreadCountUpdated);
      socket.emit('leave_dm_conversation', conversationId);
    };
  }, [conversationId, user, socket]);

  const handleAddReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;

    // Track this request's temp id so a rollback after a 409 race can't remove
    // a confirmed reaction that already arrived via reaction_added.
    const tempReactionId = `temp-${Date.now()}`;
    const optimisticReaction: Reaction = {
      id: tempReactionId,
      emoji,
      userId: user.id,
      user: { id: user.id, name: user.name || 'You' },
    };

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        return {
          ...m,
          reactions: [...(m.reactions || []), optimisticReaction],
        };
      })
    );

    try {
      await post(`/api/messages/${conversationId}/${messageId}/reactions`, { emoji });
    } catch {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          return {
            ...m,
            reactions: (m.reactions || []).filter((r) => r.id !== tempReactionId),
          };
        })
      );
      toast.error('Failed to add reaction');
    }
  }, [conversationId, user]);

  const handleRemoveReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!user) return;

    let removed: Reaction | undefined;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const next = (m.reactions || []).filter((r) => {
          if (r.emoji === emoji && r.userId === user.id) {
            removed = r;
            return false;
          }
          return true;
        });
        return { ...m, reactions: next };
      })
    );

    try {
      await del(`/api/messages/${conversationId}/${messageId}/reactions`, { emoji });
    } catch {
      if (removed) {
        const restored = removed;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, reactions: [...(m.reactions || []), restored] }
              : m
          )
        );
      }
      toast.error('Failed to remove reaction');
    }
  }, [conversationId, user]);

  const handleEditMessage = useCallback(async (messageId: string, content: string) => {
    const editedAt = new Date().toISOString();
    setMessages((prev) =>
      prev.map((m) => m.id === messageId ? { ...m, content, isEdited: true, editedAt } : m)
    );
    setEditingMessageId(null);
    try {
      await patch(`/api/messages/${conversationId}/${messageId}`, { content });
    } catch {
      toast.error('Failed to edit message');
    }
  }, [conversationId]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await del(`/api/messages/${conversationId}/${messageId}`, {});
    } catch {
      toast.error('Failed to delete message');
    }
  }, [conversationId]);

  const handleStartQuote = useCallback((m: Message) => {
    if (m.id.startsWith('temp-')) return;
    const isOwn = m.senderId === user?.id;
    const authorName = isOwn
      ? user?.name ?? 'You'
      : conversation?.otherUser?.displayName ?? conversation?.otherUser?.name ?? 'Member';
    const authorImage = isOwn ? null : conversation?.otherUser?.image ?? conversation?.otherUser?.avatarUrl ?? null;
    setQuotedMessageId(m.id);
    setActiveQuotedSnapshot({
      id: m.id,
      authorId: m.senderId,
      authorName,
      authorImage,
      contentSnippet: buildThreadPreview(m.content),
      createdAt: typeof m.createdAt === 'string' ? new Date(m.createdAt) : m.createdAt,
      isActive: true,
    });
    chatInputRef.current?.focus();
  }, [user, conversation]);

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
    if (!user || !conversationId) return;

    const activeQuoteId = quotedMessageId;
    const activeQuoteSnapshot = activeQuotedSnapshot;
    setInputValue('');
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
    const optimistic: Message = {
      id: tempId,
      conversationId,
      senderId: user.id,
      content,
      isRead: false,
      readAt: null,
      isEdited: false,
      editedAt: null,
      createdAt: new Date().toISOString(),
      fileId: attachment?.id ?? null,
      attachmentMeta,
      quotedMessageId: activeQuoteId,
      // Carry the snapshot through the optimistic phase so the embed renders
      // immediately; the server's enriched payload will replace it.
      quotedMessage: activeQuoteSnapshot ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);

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
      const response = await post<{ message?: Message }>(`/api/messages/${conversationId}`, body);
      const persistedMessage = response.message;
      if (persistedMessage) {
        setMessages((prev) => reconcileMessage(prev, persistedMessage));
      }
    } catch (error) {
      toast.error('Failed to send message');
      console.error('Error sending message:', error);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInputValue(content);
      // Restore the quote chip so the user's retry still carries the quote
      // they originally selected; without this the failed-send recovery would
      // silently strip the quote context.
      if (activeQuoteId) {
        setQuotedMessageId(activeQuoteId);
        setActiveQuotedSnapshot(activeQuoteSnapshot);
      }
    }
  };

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-muted-foreground">Loading conversation...</p>
        </div>
      </div>
    );
  }

  const otherUser = conversation.otherUser;
  const displayName = otherUser.displayName || otherUser.name;

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
    const isOwn = m.senderId === user?.id;
    const name = isOwn ? user?.name ?? 'You' : displayName;
    const initial = (name?.charAt(0) ?? '?').toUpperCase();
    return (
      <div className="flex items-start gap-3">
        <Avatar className="h-8 w-8 shrink-0">
          {!isOwn && <AvatarImage src={otherUser.image || otherUser.avatarUrl || ''} />}
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{name}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          {m.content && (
            <div className="text-sm break-words [overflow-wrap:anywhere]">
              {renderMessageParts(convertToMessageParts(m.content))}
            </div>
          )}
          <MessageAttachment message={m} />
        </div>
      </div>
    );
  };

  const resolveThreadAuthor = (authorId: string | null | undefined, fallbackName?: string | null) => {
    if (authorId === user?.id) {
      return { name: user?.name ?? 'You', image: null };
    }
    if (authorId === otherUser.id) {
      return { name: displayName, image: otherUser.image || otherUser.avatarUrl };
    }
    return { name: fallbackName ?? displayName, image: null };
  };

  const threadPanel = isThreadVisible && threadPanelParentId ? (
    <ThreadPanel
      source="dm"
      contextId={conversationId}
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
    <MessageDropZone inputRef={chatInputRef} enabled className="flex flex-col h-full flex-1 min-w-0">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border p-4">
        <div className="flex items-center gap-3 max-w-4xl mx-auto">
          <Avatar className="h-10 w-10">
            <AvatarImage src={otherUser.image || otherUser.avatarUrl || ''} />
            <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <h2 className="font-semibold">{displayName}</h2>
            {otherUser.username && (
              <p className="text-sm text-muted-foreground">@{otherUser.username}</p>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-grow overflow-hidden relative">
        <Conversation className="h-full">
          <ConversationContent className="max-w-4xl mx-auto p-4">
            {messages.map((message, i) => {
              const isOwnMessage = message.senderId === user?.id;
              const senderName = isOwnMessage ? 'You' : displayName;
              const senderAvatar = isOwnMessage ? user?.name : displayName;
              const previous = messages[i - 1];
              const isFirst = isFirstInGroup(
                { authorKey: message.senderId, createdAt: message.createdAt },
                previous ? { authorKey: previous.senderId, createdAt: previous.createdAt } : undefined,
              );
              const rowSpacing = i === 0 ? '' : isFirst ? 'mt-4' : 'mt-0.5';
              const isRealMessage = !message.id.startsWith('temp-') && editingMessageId !== message.id;
              const showOwnerActions = isOwnMessage && isRealMessage;
              const replyCount = message.replyCount ?? 0;
              const showReplyInThread = !message.id.startsWith('temp-');

              return (
                <div key={message.id} className={`group/msg flex items-start gap-4 ${rowSpacing}`}>
                  {isFirst ? (
                    <Avatar className="h-10 w-10 flex-shrink-0">
                      {isOwnMessage ? (
                        <AvatarFallback className="bg-primary text-primary-foreground">
                          {senderAvatar?.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      ) : (
                        <>
                          <AvatarImage src={otherUser.image || otherUser.avatarUrl || ''} />
                          <AvatarFallback>{senderAvatar?.charAt(0).toUpperCase()}</AvatarFallback>
                        </>
                      )}
                    </Avatar>
                  ) : (
                    <div className="h-10 w-10 flex-shrink-0 relative" aria-hidden>
                      <span className="absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground opacity-0 group-hover/msg:opacity-100 transition-opacity tabular-nums">
                        {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}

                  <div className="flex-1 min-w-0 relative group-hover/msg:pt-7 transition-[padding] duration-100">
                    {isFirst && (
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{senderName}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </span>
                        {message.isEdited && (
                          <span className="text-xs text-muted-foreground italic">(edited)</span>
                        )}
                        {message.isRead && isOwnMessage && (
                          <span className="text-xs text-muted-foreground">Read</span>
                        )}
                      </div>
                    )}

                    {editingMessageId === message.id ? (
                      <div className="mt-1 flex flex-col gap-2">
                        <textarea
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                          rows={3}
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              if (editContent.trim()) handleEditMessage(message.id, editContent.trim());
                            }
                            if (e.key === 'Escape') setEditingMessageId(null);
                          }}
                          autoFocus
                        />
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <button
                            onClick={() => { if (editContent.trim()) handleEditMessage(message.id, editContent.trim()); }}
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
                        {(message.quotedMessage || message.quotedMessageId) && (
                          <MessageQuoteBlock quoted={message.quotedMessage ?? null} />
                        )}
                        {message.content && (
                          <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere] min-w-0">
                            {renderMessageParts(convertToMessageParts(message.content))}
                          </div>
                        )}
                        <MessageAttachment message={message} />
                        {!isFirst && (message.isEdited || (message.isRead && isOwnMessage)) && (
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            {message.isEdited && (
                              <span className="italic">(edited)</span>
                            )}
                            {message.isRead && isOwnMessage && (
                              <span>Read</span>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {replyCount > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          openThread({ source: 'dm', contextId: conversationId, parentId: message.id })
                        }
                        data-testid={`thread-footer-${message.id}`}
                        className="mt-1 self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                        {message.lastReplyAt
                          ? ` · last reply ${formatDistanceToNow(new Date(message.lastReplyAt), { addSuffix: true })}`
                          : ''}
                      </button>
                    )}
                    {user && !message.id.startsWith('temp-') && (
                      <MessageReactions
                        reactions={message.reactions || []}
                        currentUserId={user.id}
                        onAddReaction={(emoji) => handleAddReaction(message.id, emoji)}
                        onRemoveReaction={(emoji) => handleRemoveReaction(message.id, emoji)}
                      />
                    )}
                    {isRealMessage && (
                      <MessageHoverToolbar
                        canReact={true}
                        canEdit={showOwnerActions}
                        canDelete={showOwnerActions}
                        canReplyInThread={showReplyInThread}
                        canQuoteReply={true}
                        reactions={message.reactions}
                        currentUserId={user?.id}
                        className="top-0"
                        onAddReaction={(emoji) => handleAddReaction(message.id, emoji)}
                        onRemoveReaction={(emoji) => handleRemoveReaction(message.id, emoji)}
                        onQuoteReply={() => handleStartQuote(message)}
                        onEdit={() => { setEditingMessageId(message.id); setEditContent(message.content); }}
                        onDelete={() => handleDeleteMessage(message.id)}
                        onReplyInThread={() =>
                          openThread({ source: 'dm', contextId: conversationId, parentId: message.id })
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

      {/* Input */}
      <div className="flex-shrink-0 border-t border-border p-4">
        <div className="max-w-4xl mx-auto">
          <MessageInput
            ref={chatInputRef}
            source="dm"
            contextId={conversationId}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleTopLevelSubmit}
            attachmentsEnabled
            quotedPreview={quotedPreview}
            onClearQuote={clearQuote}
          />
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

'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/usePermissions';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TreePage, MessageWithUser } from '@/hooks/usePageTree';
import { StreamingMarkdown } from '@/components/ai/shared/chat/StreamingMarkdown';
import { ChannelInput, type ChannelInputRef, type FileAttachment } from './ChannelInput';
import { MessageReactions, type Reaction } from './MessageReactions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Lock, FileIcon, FileText, Download } from 'lucide-react';
import { post, del, patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Pencil, Trash2, Check, X } from 'lucide-react';
import { useSocketStore } from '@/stores/useSocketStore';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import {
  type AttachmentMeta,
  type FileRelation,
  isImageAttachment,
  getFileId,
  getAttachmentName,
  getAttachmentMimeType,
  getAttachmentSize,
  formatFileSize,
  hasAttachment,
} from '@/lib/attachment-utils';

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
}

function ChannelView({ page }: ChannelViewProps) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<MessageWithReactions[]>([]);
  const [inputValue, setInputValue] = useState('');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const channelInputRef = useRef<ChannelInputRef>(null);

  // Use centralized socket store for proper authentication
  const socket = useSocketStore((state) => state.socket);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);
  const connect = useSocketStore((state) => state.connect);

  // Use the centralized permissions hook
  const { permissions } = usePermissions(page.id);
  const canEdit = permissions?.canEdit || false;
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const skipAutoScrollRef = useRef(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

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

    const handleNewMessage = (message: MessageWithUser) => {
      setMessages((prev) => {
        // If the message is already in the list, don't add it again.
        if (prev.find((m) => m.id === message.id)) {
          return prev;
        }
        return [...prev.filter(m => !m.id.startsWith('temp-')), message];
      });
    };

    socket.on('new_message', handleNewMessage);

    return () => {
      socket.off('new_message', handleNewMessage);
    };
  }, [socket, connectionStatus, page.id]);

  useEffect(() => {
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async (content: string, attachment?: FileAttachment) => {
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
      });

      // The new message will be received via the socket connection,
      // which will replace the optimistic one.
    } catch (error) {
      // If the API call fails, remove the optimistic message
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      console.error('Error sending message:', error);
      toast.error('Failed to send message. Please try again.');
    }
  };

  const handleSendMessage = (attachment?: FileAttachment) => {
    // Allow sending if there's text or an attachment
    if (!inputValue.trim() && !attachment) return;
    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }
    handleSubmit(inputValue, attachment);
    channelInputRef.current?.clear();
    setInputValue('');
  };

  // Load older messages when scrolling to top
  const handleLoadOlder = useCallback(async () => {
    if (!hasMore || loadingOlder || !nextCursor) return;
    setLoadingOlder(true);
    try {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages?cursor=${encodeURIComponent(nextCursor)}`);
      const data = await res.json();
      const olderMessages: MessageWithReactions[] = data.messages ?? data;
      skipAutoScrollRef.current = true;
      setMessages((prev) => [...olderMessages, ...prev]);
      setHasMore(data.hasMore ?? false);
      setNextCursor(data.nextCursor ?? null);
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [page.id, hasMore, loadingOlder, nextCursor]);

  // Pull-to-refresh handler for mobile - re-fetch messages if real-time missed any
  const handleRefresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages`);
      const data = await res.json();
      setMessages(data.messages ?? data);
      setHasMore(data.hasMore ?? false);
      setNextCursor(data.nextCursor ?? null);
    } catch (error) {
      console.error('Failed to refresh messages:', error);
    }
  }, [page.id]);

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

  return (
    <div className="flex flex-col h-full">
        <div className="flex-grow overflow-hidden">
          <PullToRefresh direction="top" onRefresh={handleRefresh}>
            <ScrollArea className="h-full" ref={scrollAreaRef}>
                <div className="p-4 space-y-4 max-w-4xl mx-auto">
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
                    {messages.map((m) => {
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
                        return (
                        <div key={m.id} className="group flex items-start gap-4">
                            <Avatar className="shrink-0">
                                {!isAi && <AvatarImage src={m.user?.image || ''} />}
                                <AvatarFallback>{avatarFallback}</AvatarFallback>
                            </Avatar>
                            <div className="flex flex-col min-w-0 flex-1">
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
                                    {isOwnMessage && !m.id.startsWith('temp-') && editingMessageId !== m.id && (
                                      <div className="flex items-center gap-1 ml-1">
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <button
                                              onClick={() => { setEditingMessageId(m.id); setEditContent(m.content); }}
                                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                              type="button"
                                            >
                                              <Pencil size={12} />
                                            </button>
                                          </TooltipTrigger>
                                          <TooltipContent side="top">Edit</TooltipContent>
                                        </Tooltip>
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <button
                                              onClick={() => handleDeleteMessage(m.id)}
                                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
                                              type="button"
                                            >
                                              <Trash2 size={12} />
                                            </button>
                                          </TooltipTrigger>
                                          <TooltipContent side="top">Delete</TooltipContent>
                                        </Tooltip>
                                      </div>
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
                                ) : m.content ? (
                                  <div className="prose prose-sm dark:prose-invert max-w-none">
                                    <StreamingMarkdown
                                      content={m.content}
                                      isStreaming={false}
                                    />
                                  </div>
                                ) : null}
                                {/* File attachment */}
                                {hasAttachment(m) && (
                                  <div className="mt-2">
                                    {isImageAttachment(m) ? (
                                      <a
                                        href={`/api/files/${getFileId(m)}/view?filename=${encodeURIComponent(getAttachmentName(m))}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block max-w-sm"
                                      >
                                        {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route; processor already optimizes on upload */}
                                        <img
                                          src={`/api/files/${getFileId(m)}/view`}
                                          alt={getAttachmentName(m)}
                                          className="rounded-lg max-h-64 object-contain border border-border/50"
                                        />
                                      </a>
                                    ) : (
                                      <a
                                        href={`/api/files/${getFileId(m)}/download?filename=${encodeURIComponent(getAttachmentName(m))}`}
                                        className="flex items-center gap-3 p-3 bg-muted/50 hover:bg-muted rounded-lg border border-border/50 max-w-sm transition-colors"
                                      >
                                        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center shrink-0">
                                          {getAttachmentMimeType(m).includes('pdf') ? (
                                            <FileText className="h-5 w-5 text-red-500" />
                                          ) : getAttachmentMimeType(m).includes('document') || getAttachmentMimeType(m).includes('word') ? (
                                            <FileText className="h-5 w-5 text-blue-500" />
                                          ) : (
                                            <FileIcon className="h-5 w-5 text-muted-foreground" />
                                          )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-sm font-medium truncate">{getAttachmentName(m)}</p>
                                          {getAttachmentSize(m) != null && (
                                            <p className="text-xs text-muted-foreground">
                                              {formatFileSize(getAttachmentSize(m)!)}
                                            </p>
                                          )}
                                        </div>
                                        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
                                      </a>
                                    )}
                                  </div>
                                )}
                                {/* Reactions */}
                                {user && !m.id.startsWith('temp-') && (
                                  <MessageReactions
                                    reactions={m.reactions || []}
                                    currentUserId={user.id}
                                    onAddReaction={(emoji) => handleAddReaction(m.id, emoji)}
                                    onRemoveReaction={(emoji) => handleRemoveReaction(m.id, emoji)}
                                    canReact={permissions?.canView || false}
                                  />
                                )}
                            </div>
                        </div>
                        );
                    })}
                </div>
            </ScrollArea>
          </PullToRefresh>
        </div>
        <div className="flex-shrink-0 border-t border-border p-4">
          <div className="max-w-4xl mx-auto">
            {canEdit ? (
              <ChannelInput
                ref={channelInputRef}
                value={inputValue}
                onChange={setInputValue}
                onSend={handleSendMessage}
                placeholder="Type a message... (use @ to mention, supports **markdown**)"
                driveId={page.driveId}
                channelId={page.id}
                attachmentsEnabled
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

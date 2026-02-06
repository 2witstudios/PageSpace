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
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';

interface ChannelViewProps {
  page: TreePage;
}

// Attachment metadata stored in the database
interface AttachmentMeta {
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

// Extended message type with reactions and file attachment
interface MessageWithReactions extends MessageWithUser {
  reactions?: Reaction[];
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: {
    id: string;
    mimeType: string | null;
    sizeBytes: number;
  } | null;
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

  useEffect(() => {
    const fetchMessages = async () => {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages`);
      const data = await res.json();
      setMessages(data);

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

  // Pull-to-refresh handler for mobile - re-fetch messages if real-time missed any
  const handleRefresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages`);
      const data = await res.json();
      setMessages(data);
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

    // Optimistic update
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
      await del(`/api/channels/${page.id}/messages/${messageId}/reactions`, { emoji });
    } catch {
      // Revert optimistic update on error
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
  }, [page.id, user, messages]);

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

  return (
    <div className="flex flex-col h-full">
        <PullToRefresh direction="top" onRefresh={handleRefresh}>
          <ScrollArea className="h-full flex-grow" ref={scrollAreaRef}>
              <div className="p-4 space-y-4 max-w-4xl mx-auto">
                  {messages.map((m) => (
                      <div key={m.id} className="group flex items-start gap-4">
                          <Avatar className="shrink-0">
                              <AvatarImage src={m.user?.image || ''} />
                              <AvatarFallback>{m.user?.name?.[0]}</AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                  <span className="font-semibold text-sm">{m.user?.name}</span>
                                  <span className="text-xs text-muted-foreground">
                                      {new Date(m.createdAt).toLocaleTimeString()}
                                  </span>
                              </div>
                              {m.content && (
                                <div className="prose prose-sm dark:prose-invert max-w-none">
                                  <StreamingMarkdown
                                    content={m.content}
                                    isStreaming={false}
                                  />
                                </div>
                              )}
                              {/* File attachment */}
                              {m.attachmentMeta && (
                                <div className="mt-2">
                                  {m.attachmentMeta.mimeType.startsWith('image/') ? (
                                    <a
                                      href={`/api/files/${m.fileId}/view?filename=${encodeURIComponent(m.attachmentMeta.originalName)}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block max-w-sm"
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route; processor already optimizes on upload */}
                                      <img
                                        src={`/api/files/${m.fileId}/view`}
                                        alt={m.attachmentMeta.originalName}
                                        className="rounded-lg max-h-64 object-contain border border-border/50"
                                        loading="lazy"
                                      />
                                    </a>
                                  ) : (
                                    <a
                                      href={`/api/files/${m.fileId}/download?filename=${encodeURIComponent(m.attachmentMeta.originalName)}`}
                                      className="flex items-center gap-3 p-3 bg-muted/50 hover:bg-muted rounded-lg border border-border/50 max-w-sm transition-colors"
                                    >
                                      <div className="w-10 h-10 rounded bg-muted flex items-center justify-center shrink-0">
                                        {m.attachmentMeta.mimeType.includes('pdf') ? (
                                          <FileText className="h-5 w-5 text-red-500" />
                                        ) : m.attachmentMeta.mimeType.includes('document') || m.attachmentMeta.mimeType.includes('word') ? (
                                          <FileText className="h-5 w-5 text-blue-500" />
                                        ) : (
                                          <FileIcon className="h-5 w-5 text-muted-foreground" />
                                        )}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium truncate">{m.attachmentMeta.originalName}</p>
                                        <p className="text-xs text-muted-foreground">
                                          {m.attachmentMeta.size < 1024
                                            ? `${m.attachmentMeta.size} B`
                                            : m.attachmentMeta.size < 1024 * 1024
                                            ? `${(m.attachmentMeta.size / 1024).toFixed(1)} KB`
                                            : `${(m.attachmentMeta.size / (1024 * 1024)).toFixed(1)} MB`}
                                        </p>
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
                  ))}
              </div>
          </ScrollArea>
        </PullToRefresh>
        <div className="p-4">
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

export default memo(
  ChannelView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.driveId === nextProps.page.driveId
);

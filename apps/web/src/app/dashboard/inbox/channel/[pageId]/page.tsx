'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Hash, ExternalLink, Lock, FileIcon, FileText, Download, Pencil, Trash2, Check, X, MoreHorizontal } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/usePermissions';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { StreamingMarkdown } from '@/components/ai/shared/chat/StreamingMarkdown';
import { ChannelInput, type ChannelInputRef, type FileAttachment } from '@/components/layout/middle-content/page-views/channel/ChannelInput';
import { MessageReactions, type Reaction } from '@/components/layout/middle-content/page-views/channel/MessageReactions';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { post, del, patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSocketStore } from '@/stores/useSocketStore';
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
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const channelInputRef = useRef<ChannelInputRef>(null);
  const skipAutoScrollRef = useRef(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const socket = useSocketStore((state) => state.socket);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);
  const connect = useSocketStore((state) => state.connect);
  const { permissions } = usePermissions(pageId);
  const canEdit = permissions?.canEdit || false;

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
      setMessages((prev) => {
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
  }, [socket, connectionStatus, pageId]);

  // Auto-scroll (skip when loading older messages)
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
    if (!user || !pageId) return;

    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }

    const messageContent = typeof content === 'string' ? content : JSON.stringify(content);

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: MessageWithUser = {
      id: tempId,
      pageId,
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
      await post(`/api/channels/${pageId}/messages`, {
        content: messageContent,
        fileId: attachment?.id,
        attachmentMeta: attachment ? {
          originalName: attachment.originalName,
          size: attachment.size,
          mimeType: attachment.mimeType,
          contentHash: attachment.contentHash,
        } : undefined,
      });
    } catch (error) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      console.error('Error sending message:', error);
    }
  };

  const handleSendMessage = (attachment?: FileAttachment) => {
    if (!inputValue.trim() && !attachment) return;
    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }
    handleSubmit(inputValue, attachment);
    channelInputRef.current?.clear();
    setInputValue('');
  };

  const handleRefresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/channels/${pageId}/messages`);
      if (!res.ok) {
        throw new Error(`Failed to fetch messages: ${res.status}`);
      }
      const data = await res.json();
      setMessages(data.messages ?? data);
      setHasMore(data.hasMore ?? false);
      setNextCursor(data.nextCursor ?? null);
    } catch (error) {
      console.error('Failed to refresh messages:', error);
    }
  }, [pageId]);

  const handleLoadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetchWithAuth(`/api/channels/${pageId}/messages?cursor=${encodeURIComponent(nextCursor)}`);
      if (!res.ok) throw new Error(`Failed to fetch older messages: ${res.status}`);
      const data = await res.json();
      const olderMessages: MessageWithUser[] = data.messages ?? data;
      skipAutoScrollRef.current = true;
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

  return (
    <div className="flex flex-col h-full">
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
      <div className="flex-grow overflow-hidden">
        <PullToRefresh direction="top" onRefresh={handleRefresh}>
          <ScrollArea className="h-full" ref={scrollAreaRef}>
            <div className="p-4 space-y-4 max-w-4xl mx-auto">
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
                return (
                <div key={m.id} className="flex items-start gap-4">
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              aria-label="Message options"
                              className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              type="button"
                            >
                              <MoreHorizontal size={14} aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => { setEditingMessageId(m.id); setEditContent(m.content); }}
                            >
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDeleteMessage(m.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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

      {/* Input */}
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

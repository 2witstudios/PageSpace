'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Hash, ExternalLink, Lock, FileIcon, FileText, Download } from 'lucide-react';
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
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface AttachmentMeta {
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

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
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const channelInputRef = useRef<ChannelInputRef>(null);

  const { socket, connectionStatus, connect } = useSocketStore();
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
      const res = await fetchWithAuth(`/api/channels/${pageId}/messages`);
      const data = await res.json();
      setMessages(data);
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

  // Auto-scroll
  useEffect(() => {
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
      const data = await res.json();
      setMessages(data);
    } catch (error) {
      console.error('Failed to refresh messages:', error);
    }
  }, [pageId]);

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
                          <img
                            src={`/api/files/${m.fileId}/view`}
                            alt={m.attachmentMeta.originalName}
                            className="rounded-lg max-h-64 object-contain border border-border/50"
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

      {/* Input */}
      <div className="flex-shrink-0 p-4">
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

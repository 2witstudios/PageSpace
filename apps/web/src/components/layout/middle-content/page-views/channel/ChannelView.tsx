'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/usePermissions';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TreePage, MessageWithUser } from '@/hooks/usePageTree';
import { StreamingMarkdown } from '@/components/ai/shared/chat/StreamingMarkdown';
import { ChannelInput, type ChannelInputRef } from './ChannelInput';
import { MessageReactions, type Reaction } from './MessageReactions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Lock } from 'lucide-react';
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';

interface ChannelViewProps {
  page: TreePage;
}

// Extended message type with reactions
interface MessageWithReactions extends MessageWithUser {
  reactions?: Reaction[];
}

export default function ChannelView({ page }: ChannelViewProps) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<MessageWithReactions[]>([]);
  const [inputValue, setInputValue] = useState('');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const channelInputRef = useRef<ChannelInputRef>(null);

  // Use centralized socket store for proper authentication
  const { socket, connectionStatus, connect } = useSocketStore();

  // Use the centralized permissions hook
  const { permissions } = usePermissions(page.id);
  const canEdit = permissions?.canEdit || false;

  useEffect(() => {
    const fetchMessages = async () => {
      const res = await fetchWithAuth(`/api/channels/${page.id}/messages`);
      const data = await res.json();
      setMessages(data);
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

  const handleSubmit = async (content: string) => {
    if (!user) return;
    
    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }

    const messageContent = typeof content === 'string' ? content : JSON.stringify(content);

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: MessageWithUser = {
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
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      await post(`/api/channels/${page.id}/messages`, { content: messageContent });

      // The new message will be received via the socket connection,
      // which will replace the optimistic one.
    } catch (error) {
      // If the API call fails, remove the optimistic message
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      console.error('Error sending message:', error);
    }
  };

  const handleSendMessage = () => {
    if (!inputValue.trim()) return;
    if (!canEdit) {
      toast.error(getPermissionErrorMessage('send', 'channel'));
      return;
    }
    handleSubmit(inputValue);
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
    } catch (_error) {
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
    } catch (_error) {
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
          // Avoid duplicates
          const exists = m.reactions?.some((r) => r.id === data.reaction.id);
          if (exists) return m;
          return {
            ...m,
            reactions: [...(m.reactions || []).filter(r => !r.id.startsWith('temp-')), data.reaction],
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
              <div className="p-4 space-y-4">
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
                              <div className="prose prose-sm dark:prose-invert max-w-none">
                                <StreamingMarkdown
                                  content={m.content}
                                  isStreaming={false}
                                />
                              </div>
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
          {canEdit ? (
            <ChannelInput
              ref={channelInputRef}
              value={inputValue}
              onChange={setInputValue}
              onSend={handleSendMessage}
              placeholder="Type a message... (use @ to mention, supports **markdown**)"
              driveId={page.driveId}
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
  );
}
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
import { ChannelInput, type ChannelInputRef } from '@/components/layout/middle-content/page-views/channel/ChannelInput';
import type { FileAttachment } from '@/hooks/useAttachmentUpload';
import { MessageAttachment } from '@/components/shared/MessageAttachment';
import { renderMessageParts, convertToMessageParts } from '@/components/messages/MessagePartRenderer';
import type { AttachmentMeta } from '@/lib/attachment-utils';
import useSWR from 'swr';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { post, patch, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Pencil, Trash2, Check, X, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
  const chatInputRef = useRef<ChannelInputRef>(null);
  const socket = useSocket();

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
      if (message.conversationId === conversationId) {
        setMessages((prev) => reconcileMessage(prev, message));

        if (message.senderId !== user.id) {
          patch(`/api/messages/${conversationId}`);
        }
      }
    };

    socket.on('new_dm_message', handleNewMessage);

    return () => {
      socket.off('new_dm_message', handleNewMessage);
      socket.emit('leave_dm_conversation', conversationId);
    };
  }, [conversationId, user, socket]);

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

  const handleSendMessage = async (attachment?: FileAttachment) => {
    if (!user || !conversationId) return;
    const content = inputValue;
    if (!content.trim() && !attachment) return;

    setInputValue('');

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
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const body: { content: string; fileId?: string; attachmentMeta?: AttachmentMeta } = {
        content,
      };
      if (attachment) {
        body.fileId = attachment.id;
        body.attachmentMeta = attachmentMeta!;
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

  return (
    <div className="flex flex-col h-full">
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
        <Conversation>
          <ConversationContent className="gap-4 max-w-4xl mx-auto p-4">
            {messages.map((message) => {
              const isOwnMessage = message.senderId === user?.id;
              const senderName = isOwnMessage ? 'You' : displayName;
              const senderAvatar = isOwnMessage ? user?.name : displayName;

              return (
                <div key={message.id} className="flex items-start gap-4">
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

                  <div className="flex-1 min-w-0">
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
                      {isOwnMessage && editingMessageId !== message.id && (
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
                              onClick={() => { setEditingMessageId(message.id); setEditContent(message.content); }}
                            >
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDeleteMessage(message.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>

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
                      <div className={`p-3 rounded-lg max-w-full ${
                        isOwnMessage
                          ? 'bg-primary/5 dark:bg-primary/10 ml-8'
                          : 'bg-gray-50 dark:bg-gray-800/50 mr-8'
                      }`}>
                        {message.content && (
                          <div className="text-gray-900 dark:text-gray-100 break-words [overflow-wrap:anywhere] min-w-0">
                            {renderMessageParts(convertToMessageParts(message.content))}
                          </div>
                        )}
                        <MessageAttachment message={message} />
                      </div>
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
          <ChannelInput
            ref={chatInputRef}
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSendMessage}
            placeholder="Type a message... (use @ to mention, supports **markdown**)"
            conversationId={conversationId}
            attachmentsEnabled
          />
        </div>
      </div>
    </div>
  );
}

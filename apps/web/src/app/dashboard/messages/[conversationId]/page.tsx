'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ChatInput, { ChatInputRef } from '@/components/messages/ChatInput';
import { renderMessageParts, convertToMessageParts } from '@/components/messages/MessagePartRenderer';
import useSWR from 'swr';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { post, patch } from '@/lib/auth-fetch';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

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
}

interface Conversation {
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

export default function ConversationPage() {
  const params = useParams();
  const conversationId = params.conversationId as string;
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const socket = useSocket();

  // Fetch conversation details
  const { data: conversationData } = useSWR<{ conversations: Conversation[] }>(
    '/api/messages/conversations',
    fetcher
  );

  const conversation = conversationData?.conversations?.find(
    (c) => c.id === conversationId
  );

  // Fetch messages
  const { data: messagesData } = useSWR<{ messages: Message[] }>(
    conversationId ? `/api/messages/${conversationId}` : null,
    fetcher,
    {
      refreshInterval: 0, // We'll use socket.io for real-time updates
    }
  );

  useEffect(() => {
    if (messagesData?.messages) {
      setMessages(messagesData.messages);
    }
  }, [messagesData]);

  // Socket room join and updates via global socket
  useEffect(() => {
    if (!user || !conversationId || !socket) return;

    // Join conversation room
    socket.emit('join_dm_conversation', conversationId);

    const handleNewMessage = (message: Message) => {
      if (message.conversationId === conversationId) {
        setMessages((prev) => {
          if (prev.find((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });

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

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async () => {
    if (!user || !conversationId || !inputValue.trim()) return;

    const content = inputValue;
    setInputValue(''); // Clear input immediately

    try {
      await post(`/api/messages/${conversationId}`, { content });

      // Message will be added via socket broadcast from server
      // No need for optimistic update as it causes duplicates
    } catch (error) {
      toast.error('Failed to send message');
      console.error('Error sending message:', error);
      setInputValue(content); // Restore input on error
    }
  };

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
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
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-3">
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
      <div className="flex-grow overflow-hidden">
        <ScrollArea className="h-full p-4" ref={scrollAreaRef}>
          <div className="space-y-4 max-w-4xl mx-auto">
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
                      <span className="text-xs text-muted-foreground">• Read</span>
                    )}
                  </div>

                  <div className={`p-3 rounded-lg ${
                    isOwnMessage
                      ? 'bg-primary/5 dark:bg-primary/10 ml-8'
                      : 'bg-gray-50 dark:bg-gray-800/50 mr-8'
                  }`}>
                    <div className="text-gray-900 dark:text-gray-100">
                      {renderMessageParts(convertToMessageParts(message.content))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </ScrollArea>
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <ChatInput
          ref={chatInputRef}
          value={inputValue}
          onChange={setInputValue}
          onSendMessage={handleSendMessage}
          placeholder="Type a message..."
        />
      </div>
    </div>
  );
}

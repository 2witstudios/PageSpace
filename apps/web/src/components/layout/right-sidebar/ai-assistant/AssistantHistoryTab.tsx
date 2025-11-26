import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, Search, MessageSquare, Bot, Sparkles } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { del, fetchWithAuth } from '@/lib/auth-fetch';
import { useGlobalChat } from '@/contexts/GlobalChatContext';

interface Conversation {
  id: string;
  title: string;
  type: string;
  lastMessageAt: string;
  createdAt: string;
  // For agent conversations from the different API format
  updatedAt?: string;
  messageCount?: number;
  preview?: string;
}

const AssistantHistoryTab: React.FC = () => {
  const pathname = usePathname();

  // Use GlobalChatContext for conversation management
  const {
    loadConversation,
    createNewConversation: createNewGlobalConversation,
    currentConversationId: globalConversationId,
    // Agent selection
    selectedAgent,
    loadAgentConversation,
    createAgentConversation,
  } = useGlobalChat();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filteredConversations, setFilteredConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load conversations on mount and when conversation, agent, or pathname changes
  useEffect(() => {
    const loadConversations = async () => {
      setLoading(true);
      try {
        // Use different API based on whether an agent is selected
        const apiUrl = selectedAgent
          ? `/api/agents/${selectedAgent.id}/conversations`
          : '/api/ai_conversations';

        const response = await fetchWithAuth(apiUrl);
        if (response.ok) {
          const data = await response.json();

          // Handle different response formats
          let conversationList: Conversation[];
          if (selectedAgent) {
            // Agent API returns { conversations: [...], pagination: {...} }
            conversationList = (data.conversations || []).map((conv: {
              id: string;
              title: string;
              preview?: string;
              createdAt: string;
              updatedAt: string;
              messageCount: number;
            }) => ({
              id: conv.id,
              title: conv.title || conv.preview || 'New Conversation',
              type: 'agent',
              lastMessageAt: conv.updatedAt,
              createdAt: conv.createdAt,
              messageCount: conv.messageCount,
            }));
          } else {
            // Global API returns array directly
            conversationList = data;
          }

          setConversations(conversationList);
          setFilteredConversations(conversationList);
        }
      } catch (error) {
        console.error('Failed to load conversations:', error);
        setConversations([]);
        setFilteredConversations([]);
      } finally {
        setLoading(false);
      }
    };

    loadConversations();
  }, [globalConversationId, pathname, selectedAgent]); // Refetch when conversation, agent, or navigation changes

  // Sync local active conversation ID with global context
  useEffect(() => {
    setActiveConversationId(globalConversationId);
  }, [globalConversationId]);

  // Filter conversations based on search query
  useEffect(() => {
    if (searchQuery.trim() === '') {
      setFilteredConversations(conversations);
    } else {
      const filtered = conversations.filter(conv =>
        conv.title?.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredConversations(filtered);
    }
  }, [searchQuery, conversations]);

  const handleConversationClick = async (conversationId: string) => {
    // Load conversation using GlobalChatContext - this updates the shared Chat instance
    if (selectedAgent) {
      // Load agent conversation
      await loadAgentConversation(selectedAgent.id, conversationId);
    } else {
      // Load global conversation
      await loadConversation(conversationId);
    }

    setActiveConversationId(conversationId);

    // Update URL for browser history
    const url = new URL(window.location.href);
    url.searchParams.set('c', conversationId);
    if (selectedAgent) {
      url.searchParams.set('agent', selectedAgent.id);
    }
    window.history.pushState({}, '', url.toString());
  };

  const handleDeleteConversation = async (conversationId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent conversation click

    if (!confirm('Are you sure you want to delete this conversation?')) {
      return;
    }

    try {
      // Use different API endpoint based on mode
      const deleteUrl = selectedAgent
        ? `/api/agents/${selectedAgent.id}/conversations/${conversationId}`
        : `/api/ai_conversations/${conversationId}`;

      await del(deleteUrl);

      // Remove from local state
      const updatedConversations = conversations.filter(conv => conv.id !== conversationId);
      setConversations(updatedConversations);
      setFilteredConversations(updatedConversations.filter(conv =>
        conv.title?.toLowerCase().includes(searchQuery.toLowerCase()) || searchQuery.trim() === ''
      ));

      // If deleted conversation was active, create a new one
      if (conversationId === activeConversationId) {
        if (selectedAgent) {
          // Create new agent conversation
          await createAgentConversation(selectedAgent.id);
        } else {
          // Create new global conversation
          await createNewGlobalConversation();
        }
        // setActiveConversationId will be updated via the sync useEffect
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b">
          <h3 className="text-sm font-medium">Conversation History</h3>
        </div>
        <div className="flex-grow flex items-center justify-center">
          <div className="text-sm text-muted-foreground">Loading conversations...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center gap-2">
          {selectedAgent ? (
            <Bot className="h-4 w-4 text-primary" />
          ) : (
            <Sparkles className="h-4 w-4 text-primary" />
          )}
          <h3 className="text-sm font-medium truncate">
            {selectedAgent ? `${selectedAgent.title} History` : 'Conversation History'}
          </h3>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2 h-3 w-3 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-7 h-8 text-xs"
          />
        </div>
      </div>

      {/* Conversations List - with native scrolling */}
      <div className="flex-grow overflow-y-auto">
        <div className="p-2">
          {filteredConversations.length === 0 ? (
            <div className="text-center py-8">
              <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                {searchQuery ? 'No conversations found' : 'No conversations yet'}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  onClick={() => handleConversationClick(conversation.id)}
                  className={`group p-3 rounded-lg border cursor-pointer hover:bg-accent transition-colors ${
                    conversation.id === activeConversationId
                      ? 'bg-accent/50 border-accent-foreground/20'
                      : 'border-border'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-grow min-w-0">
                      <h4 className="text-sm font-medium truncate">
                        {conversation.title || 'New Conversation'}
                      </h4>
                      <p className={`text-xs mt-1 ${conversation.id === activeConversationId ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'}`}>
                        {formatDistanceToNow(new Date(conversation.lastMessageAt || conversation.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => handleDeleteConversation(conversation.id, e)}
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      
      {/* Footer - for consistent structure */}
      <div className="border-t p-3">
        <div className="text-xs text-muted-foreground text-center">
          {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
        </div>
      </div>
    </div>
  );
};

export default AssistantHistoryTab;
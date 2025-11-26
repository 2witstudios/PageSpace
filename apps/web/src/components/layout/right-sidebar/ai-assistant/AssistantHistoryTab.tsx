import React, { useEffect, useState, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, Search, MessageSquare, Sparkles, Bot } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { del, fetchWithAuth } from '@/lib/auth-fetch';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { SidebarAgentInfo, useSidebarAgentState } from '@/hooks/useSidebarAgentState';

interface Conversation {
  id: string;
  title: string;
  type: string;
  lastMessageAt: string;
  createdAt: string;
}

interface AssistantHistoryTabProps {
  selectedAgent: SidebarAgentInfo | null;
}

/**
 * Assistant history tab for the right sidebar.
 *
 * Supports both Global Assistant mode (selectedAgent = null) and Agent mode.
 * When an agent is selected, loads and manages that agent's conversation history.
 */
const AssistantHistoryTab: React.FC<AssistantHistoryTabProps> = ({ selectedAgent }) => {
  const pathname = usePathname();

  // Use GlobalChatContext for GLOBAL conversation management only
  const {
    loadConversation: loadGlobalConversation,
    createNewConversation: createNewGlobalConversation,
    currentConversationId: globalConversationId,
  } = useGlobalChat();

  // Use sidebar agent state for agent conversation management
  const {
    conversationId: agentConversationId,
    createNewConversation: createNewAgentConversation,
    refreshConversation: refreshAgentConversation,
  } = useSidebarAgentState();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Filter conversations based on search query (useMemo instead of useEffect + state)
  const filteredConversations = useMemo(() => {
    if (searchQuery.trim() === '') {
      return conversations;
    }
    return conversations.filter(conv =>
      conv.title?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, conversations]);

  // Load conversations based on mode (global or agent)
  useEffect(() => {
    const loadConversations = async () => {
      setLoading(true);
      try {
        // Switch endpoint based on whether an agent is selected
        const endpoint = selectedAgent
          ? `/api/agents/${selectedAgent.id}/conversations`
          : '/api/ai_conversations';

        const response = await fetchWithAuth(endpoint);
        if (response.ok) {
          const data = await response.json();
          // Agent endpoint returns { conversations: [...] }, global returns array directly
          setConversations(selectedAgent ? data.conversations || [] : data);
        }
      } catch (error) {
        console.error('Failed to load conversations:', error);
        setConversations([]);
      } finally {
        setLoading(false);
      }
    };

    loadConversations();
  }, [selectedAgent, globalConversationId, agentConversationId, pathname]); // Refetch when agent, conversation, or navigation changes

  // Sync local active conversation ID based on mode
  useEffect(() => {
    if (selectedAgent) {
      setActiveConversationId(agentConversationId);
    } else {
      setActiveConversationId(globalConversationId);
    }
  }, [selectedAgent, globalConversationId, agentConversationId]);

  const handleConversationClick = async (conversationId: string) => {
    if (selectedAgent) {
      // For agent mode, we need to load the conversation messages
      // The useSidebarAgentState hook handles this when we refresh
      try {
        const messagesResponse = await fetchWithAuth(
          `/api/agents/${selectedAgent.id}/conversations/${conversationId}/messages`
        );
        if (messagesResponse.ok) {
          // Trigger a state update via the sidebar agent state
          // For now, just set local active and refresh will sync
          setActiveConversationId(conversationId);
          // Refresh to sync conversation data
          await refreshAgentConversation();
        }
      } catch (error) {
        console.error('Failed to load agent conversation:', error);
      }
    } else {
      // Load GLOBAL conversation using GlobalChatContext
      await loadGlobalConversation(conversationId);
      setActiveConversationId(conversationId);

      // Update URL for browser history
      const url = new URL(window.location.href);
      url.searchParams.set('c', conversationId);
      window.history.pushState({}, '', url.toString());
    }
  };

  const handleDeleteConversation = async (conversationId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent conversation click

    if (!confirm('Are you sure you want to delete this conversation?')) {
      return;
    }

    try {
      // Delete based on mode
      if (selectedAgent) {
        await del(`/api/agents/${selectedAgent.id}/conversations/${conversationId}`);
      } else {
        await del(`/api/ai_conversations/${conversationId}`);
      }

      // Remove from local state (useMemo handles filtering automatically)
      setConversations(conversations.filter(conv => conv.id !== conversationId));

      // If deleted conversation was active, create a new conversation
      if (conversationId === activeConversationId) {
        if (selectedAgent) {
          await createNewAgentConversation();
        } else {
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
      {/* Header - Shows agent name or Global Assistant */}
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
import React, { useEffect, useState, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Trash2, Search, MessageSquare, Sparkles, Bot } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { usePageAgentSidebarState } from '@/hooks/page-agents/usePageAgentSidebarState';
import { usePageAgentDashboardStore } from '@/stores/page-agents/usePageAgentDashboardStore';
import type { AgentInfo } from '@/types/agent';

interface Conversation {
  id: string;
  title: string;
  type: string;
  lastMessageAt: string;
  createdAt: string;
}

interface SidebarHistoryTabProps {
  selectedAgent: AgentInfo | null;
  isDashboardContext?: boolean;
}

/**
 * Assistant history tab for the right sidebar.
 *
 * Supports both Global Assistant mode (selectedAgent = null) and Agent mode.
 *
 * On dashboard context:
 * - Uses usePageAgentDashboardStore directly (shared with GlobalAssistantView)
 * - Clicking a conversation loads it into the middle panel
 *
 * On page context:
 * - Uses usePageAgentSidebarState (independent from page content)
 * - Clicking a conversation loads it into the sidebar chat
 */
const SidebarHistoryTab: React.FC<SidebarHistoryTabProps> = ({
  selectedAgent,
  isDashboardContext = false,
}) => {
  const pathname = usePathname();

  // Use GlobalChatContext for GLOBAL conversation management only
  const {
    loadConversation: loadGlobalConversation,
    createNewConversation: createNewGlobalConversation,
    currentConversationId: globalConversationId,
  } = useGlobalChat();

  // Use sidebar agent state for agent conversation management (page context)
  const {
    conversationId: sidebarAgentConversationId,
    createNewConversation: createNewSidebarAgentConversation,
    refreshConversation: refreshSidebarAgentConversation,
  } = usePageAgentSidebarState();

  // Use central agent store for dashboard context
  const agentStore = usePageAgentDashboardStore();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  // Determine active conversation ID based on context
  const activeConversationId = useMemo(() => {
    if (selectedAgent) {
      // Agent mode
      return isDashboardContext ? agentStore.conversationId : sidebarAgentConversationId;
    }
    // Global assistant mode
    return globalConversationId;
  }, [selectedAgent, isDashboardContext, agentStore.conversationId, sidebarAgentConversationId, globalConversationId]);

  // Filter conversations based on search query
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
          ? `/api/ai/page-agents/${selectedAgent.id}/conversations`
          : '/api/ai/global';

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
  }, [selectedAgent, globalConversationId, activeConversationId, pathname]); // Refetch when agent, conversation, or navigation changes

  const handleConversationClick = async (conversationId: string) => {
    if (selectedAgent) {
      if (isDashboardContext) {
        // Dashboard context: load into shared agent store (GlobalAssistantView will react)
        await agentStore.loadConversation(conversationId);
      } else {
        // Page context: load into sidebar's own state
        try {
          const messagesResponse = await fetchWithAuth(
            `/api/ai/page-agents/${selectedAgent.id}/conversations/${conversationId}/messages`
          );
          if (messagesResponse.ok) {
            // Refresh to sync conversation data
            await refreshSidebarAgentConversation();
          }
        } catch (error) {
          console.error('Failed to load agent conversation:', error);
        }
      }
    } else {
      // Load GLOBAL conversation using GlobalChatContext
      await loadGlobalConversation(conversationId);

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
        await del(`/api/ai/page-agents/${selectedAgent.id}/conversations/${conversationId}`);
      } else {
        await del(`/api/ai/global/${conversationId}`);
      }

      // Remove from local state
      setConversations(conversations.filter(conv => conv.id !== conversationId));

      // If deleted conversation was active, create a new conversation
      if (conversationId === activeConversationId) {
        if (selectedAgent) {
          if (isDashboardContext) {
            await agentStore.createNewConversation();
          } else {
            await createNewSidebarAgentConversation();
          }
        } else {
          await createNewGlobalConversation();
        }
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        {/* Skeleton header */}
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
        {/* Skeleton conversation list */}
        <div className="flex-grow p-2 space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-3 rounded-lg border border-border">
              <div className="flex items-start justify-between">
                <div className="flex-grow space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-6 w-6 rounded" />
              </div>
            </div>
          ))}
        </div>
        {/* Skeleton footer */}
        <div className="border-t p-3">
          <Skeleton className="h-3 w-24 mx-auto" />
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

export default SidebarHistoryTab;

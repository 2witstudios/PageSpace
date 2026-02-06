import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Trash2, Search, MessageSquare, Bot, Loader2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { formatDistanceToNow } from 'date-fns';
import { del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { usePageAgentSidebarState } from '@/hooks/page-agents';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { setConversationId } from '@/lib/url-state';
import { VirtualizedConversationList } from '@/components/ai/shared/chat';
import type { AgentInfo } from '@/types/agent';

// Threshold for enabling virtualization
const VIRTUALIZATION_THRESHOLD = 30;

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
  } = useGlobalChatConversation();

  // Use sidebar agent state for agent conversation management (page context)
  const {
    conversationId: sidebarAgentConversationId,
    createNewConversation: createNewSidebarAgentConversation,
    refreshConversation: refreshSidebarAgentConversation,
  } = usePageAgentSidebarState();

  // Use central agent store for dashboard context
  const dashboardConversationId = usePageAgentDashboardStore((state) => state.conversationId);
  const loadDashboardConversation = usePageAgentDashboardStore((state) => state.loadConversation);
  const createDashboardConversation = usePageAgentDashboardStore((state) => state.createNewConversation);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Determine active conversation ID based on context
  const activeConversationId = useMemo(() => {
    if (selectedAgent) {
      // Agent mode
      return isDashboardContext ? dashboardConversationId : sidebarAgentConversationId;
    }
    // Global assistant mode
    return globalConversationId;
  }, [selectedAgent, isDashboardContext, dashboardConversationId, sidebarAgentConversationId, globalConversationId]);

  // Filter conversations based on search query
  const filteredConversations = useMemo(() => {
    if (searchQuery.trim() === '') {
      return conversations;
    }
    return conversations.filter(conv =>
      conv.title?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, conversations]);

  // Load conversations based on mode (global or agent) with pagination
  useEffect(() => {
    const loadConversations = async () => {
      // Reset state for new loads
      setLoading(true);
      setConversations([]);
      setNextCursor(null);
      setHasMore(false);

      try {
        // Switch endpoint based on whether an agent is selected
        // Global mode uses pagination, agent mode uses array format
        const endpoint = selectedAgent
          ? `/api/ai/page-agents/${selectedAgent.id}/conversations`
          : '/api/ai/global?paginated=true&limit=30';

        const response = await fetchWithAuth(endpoint);
        if (response.ok) {
          const data = await response.json();
          if (selectedAgent) {
            // Agent endpoint returns { conversations: [...] }
            setConversations(data.conversations || []);
            setHasMore(false);
          } else {
            // Global endpoint with pagination
            setConversations(data.conversations || []);
            setHasMore(data.pagination?.hasMore ?? false);
            setNextCursor(data.pagination?.nextCursor ?? null);
          }
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

  // Load more conversations (for pagination)
  const handleLoadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !nextCursor || selectedAgent) return;

    setLoadingMore(true);
    try {
      const response = await fetchWithAuth(
        `/api/ai/global?paginated=true&limit=30&cursor=${nextCursor}&direction=before`
      );
      if (response.ok) {
        const data = await response.json();
        setConversations(prev => [...prev, ...(data.conversations || [])]);
        setHasMore(data.pagination?.hasMore ?? false);
        setNextCursor(data.pagination?.nextCursor ?? null);
      }
    } catch (error) {
      console.error('Failed to load more conversations:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, nextCursor, selectedAgent]);

  const handleConversationClick = useCallback(async (conversationId: string) => {
    if (selectedAgent) {
      if (isDashboardContext) {
        // Dashboard context: load into shared agent store (GlobalAssistantView will react)
        await loadDashboardConversation(conversationId);
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
      setConversationId(conversationId, 'push');
    }
  }, [
    selectedAgent,
    isDashboardContext,
    loadDashboardConversation,
    refreshSidebarAgentConversation,
    loadGlobalConversation,
  ]);

  const handleDeleteConversation = useCallback(async (conversationId: string) => {
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

      // Remove from local state using functional update to avoid stale closure
      setConversations(prev => prev.filter(conv => conv.id !== conversationId));

      // If deleted conversation was active, create a new conversation
      if (conversationId === activeConversationId) {
        if (selectedAgent) {
          if (isDashboardContext) {
            await createDashboardConversation();
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
  }, [
    selectedAgent,
    activeConversationId,
    isDashboardContext,
    createDashboardConversation,
    createNewSidebarAgentConversation,
    createNewGlobalConversation,
  ]);

  // Determine if we should virtualize based on conversation count
  const shouldVirtualize = filteredConversations.length >= VIRTUALIZATION_THRESHOLD;

  // Memoized render function for conversation items
  const renderConversation = useCallback((conversation: Conversation) => (
    <ContextMenu key={conversation.id}>
      <ContextMenuTrigger asChild>
        <div
          onClick={() => handleConversationClick(conversation.id)}
          className={`py-1 px-3 cursor-pointer hover:bg-accent/50 transition-colors relative ${
            conversation.id === activeConversationId
              ? 'bg-accent/50 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-primary'
              : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="flex-grow truncate text-sm">
              {conversation.title || 'New Conversation'}
            </span>
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {formatDistanceToNow(new Date(conversation.lastMessageAt || conversation.createdAt), {
                addSuffix: true,
              })}
            </span>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem
          onSelect={() => handleDeleteConversation(conversation.id)}
          className="text-red-500 focus:text-red-500"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Delete</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ), [activeConversationId, handleConversationClick, handleDeleteConversation]);

  // Get key for virtualization
  const getConversationKey = useCallback((conversation: Conversation) => conversation.id, []);

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
        <div className="flex-grow">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="py-1 px-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 flex-grow" />
                <Skeleton className="h-3 w-12 flex-shrink-0" />
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
          {selectedAgent && (
            <Bot className="h-4 w-4 text-primary" />
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

      {/* Conversations List */}
      <div className="flex-grow min-h-0 overflow-hidden">
        {filteredConversations.length === 0 ? (
          <div className="text-center py-8">
            <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">
              {searchQuery ? 'No conversations found' : 'No conversations yet'}
            </p>
          </div>
        ) : shouldVirtualize ? (
          // Virtualized rendering for large lists
          <VirtualizedConversationList
            conversations={filteredConversations}
            renderConversation={renderConversation}
            getKey={getConversationKey}
            onScrollNearBottom={hasMore ? handleLoadMore : undefined}
            isLoadingMore={loadingMore}
            estimatedRowHeight={32}
            overscan={5}
            gap={0}
          />
        ) : (
          // Regular rendering for smaller lists
          <div
            ref={scrollContainerRef}
            className="overflow-y-auto h-full"
            onScroll={() => {
              // Check if scrolled near bottom to load more
              const container = scrollContainerRef.current;
              if (!container || !hasMore || loadingMore) return;
              const { scrollTop, scrollHeight, clientHeight } = container;
              if (scrollHeight - scrollTop - clientHeight < 100) {
                handleLoadMore();
              }
            }}
          >
            {filteredConversations.map(conversation => renderConversation(conversation))}
            {loadingMore && (
              <div className="flex items-center justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                <span className="text-xs text-muted-foreground">Loading more...</span>
              </div>
            )}
          </div>
        )}
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

export default React.memo(SidebarHistoryTab);

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, Search, MessageSquare, Sparkles } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { del, fetchWithAuth } from '@/lib/auth-fetch';
import { useGlobalChat } from '@/contexts/GlobalChatContext';

interface Conversation {
  id: string;
  title: string;
  type: string;
  lastMessageAt: string;
  createdAt: string;
}

interface AssistantHistoryTabProps {
  /**
   * When true, always show global conversation history regardless of selectedAgent.
   * Used when sidebar is displayed alongside agent chat in middle view.
   */
  forceGlobal?: boolean;
}

const AssistantHistoryTab: React.FC<AssistantHistoryTabProps> = ({ forceGlobal = false }) => {
  const pathname = usePathname();

  // Use GlobalChatContext for GLOBAL conversation management
  // This component ALWAYS shows Global Assistant history
  // Agent history is handled by GlobalAssistantView's local AgentHistoryTab
  const {
    loadConversation,
    createNewConversation: createNewGlobalConversation,
    currentConversationId: globalConversationId,
  } = useGlobalChat();

  // Note: forceGlobal prop is kept for backwards compatibility but component always shows global
  void forceGlobal;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filteredConversations, setFilteredConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load GLOBAL conversations on mount and when conversation or pathname changes
  // Agent conversations are handled by GlobalAssistantView's local AgentHistoryTab
  useEffect(() => {
    const loadConversations = async () => {
      setLoading(true);
      try {
        // Always load global conversations
        const response = await fetchWithAuth('/api/ai_conversations');
        if (response.ok) {
          const data = await response.json();
          setConversations(data);
          setFilteredConversations(data);
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
  }, [globalConversationId, pathname]); // Refetch when conversation or navigation changes

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
    // Load GLOBAL conversation using GlobalChatContext
    // Agent conversations are handled by GlobalAssistantView's local AgentHistoryTab
    await loadConversation(conversationId);
    setActiveConversationId(conversationId);

    // Update URL for browser history
    const url = new URL(window.location.href);
    url.searchParams.set('c', conversationId);
    window.history.pushState({}, '', url.toString());
  };

  const handleDeleteConversation = async (conversationId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent conversation click

    if (!confirm('Are you sure you want to delete this conversation?')) {
      return;
    }

    try {
      // Delete GLOBAL conversation
      // Agent conversation deletion is handled by GlobalAssistantView's local AgentHistoryTab
      await del(`/api/ai_conversations/${conversationId}`);

      // Remove from local state
      const updatedConversations = conversations.filter(conv => conv.id !== conversationId);
      setConversations(updatedConversations);
      setFilteredConversations(updatedConversations.filter(conv =>
        conv.title?.toLowerCase().includes(searchQuery.toLowerCase()) || searchQuery.trim() === ''
      ));

      // If deleted conversation was active, create a new global conversation
      if (conversationId === activeConversationId) {
        await createNewGlobalConversation();
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
      {/* Header - Always shows Global Assistant history */}
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium truncate">
            Conversation History
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
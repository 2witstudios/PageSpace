import React, { useEffect, useState, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import ChatInput, { ChatInputRef } from '@/components/messages/ChatInput';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, Plus } from 'lucide-react';
import { CompactConversationMessageRenderer } from '@/components/ai/CompactConversationMessageRenderer';
import { AgentRole, AgentRoleUtils } from '@/lib/ai/agent-roles';
import { AgentRoleDropdownCompact } from '@/components/ai/AgentRoleDropdown';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth, patch, del } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { toast } from 'sonner';
import { UIMessage } from 'ai';


interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: {
    pagespace?: { isConfigured: boolean; hasApiKey: boolean };
    openrouter: { isConfigured: boolean; hasApiKey: boolean };
    google: { isConfigured: boolean; hasApiKey: boolean };
  };
  isAnyProviderConfigured: boolean;
}

interface LocationContext {
  currentPage?: {
    id: string;
    title: string;
    type: string;
    path: string;
  } | null;
  currentDrive?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  breadcrumbs?: string[];
}


const AssistantChatTab: React.FC = () => {
  const pathname = usePathname();

  // Use shared global chat context - this is the key change!
  const { chat, currentConversationId, isInitialized, createNewConversation } = useGlobalChat();

  // Local state for component-specific concerns
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [input, setInput] = useState<string>('');
  const [currentAgentRole, setCurrentAgentRole] = useState<AgentRole>(AgentRoleUtils.getDefaultRole());
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);
  
  // Refs for auto-scrolling and chat input
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  
  // Auto-scroll to bottom function
  const scrollToBottom = () => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  };

  // Get fetchDrives from store to ensure drives are loaded
  // Note: We don't subscribe to drives array to avoid re-renders
  const { fetchDrives } = useDriveStore();

  // Ensure drives are loaded on mount
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);
  
  // Extract location context from pathname
  // Note: Only depends on pathname, not drives array, to prevent re-fetching on drive refreshes
  useEffect(() => {
    const extractLocationContext = async () => {
      const pathParts = pathname.split('/').filter(Boolean);

      if (pathParts.length >= 2 && pathParts[0] === 'dashboard') {
        const driveId = pathParts[1];

        try {
          let currentPage = null;
          let currentDrive = null;

          // Get drive information from store (using current drives snapshot)
          if (driveId) {
            const currentDrives = useDriveStore.getState().drives;
            const driveData = currentDrives.find(d => d.id === driveId);
            if (driveData) {
              currentDrive = {
                id: driveData.id,
                slug: driveData.slug,
                name: driveData.name
              };
            }
            // If drive not found in store, set to null (no fallback with fake data)
          }
          
          // Fetch page information if we have a page ID in the path
          if (pathParts.length > 2) {
            const pageId = pathParts[2];
            
            try {
              // Fetch page data
              const pageResponse = await fetchWithAuth(`/api/pages/${pageId}`);
              if (pageResponse.ok) {
                const pageData = await pageResponse.json();
                
                // Fetch breadcrumbs to build the full path with parent folders
                try {
                  const breadcrumbsResponse = await fetchWithAuth(`/api/pages/${pageId}/breadcrumbs`);
                  if (breadcrumbsResponse.ok) {
                    const breadcrumbsData = await breadcrumbsResponse.json();
                    
                    // Build the full path from breadcrumbs: /driveSlug/Folder1/Folder2/PageTitle
                    // The AI tools expect paths with actual page titles, not IDs
                    const pathSegments = breadcrumbsData.map((crumb: { title: string }) => crumb.title);
                    const fullPath = `/${currentDrive?.slug}/${pathSegments.join('/')}`;
                    
                    currentPage = {
                      id: pageData.id,
                      title: pageData.title,
                      type: pageData.type,
                      path: fullPath
                    };
                  } else {
                    // Fallback to simple path if breadcrumbs fail
                    currentPage = {
                      id: pageData.id,
                      title: pageData.title,
                      type: pageData.type,
                      path: `/${currentDrive?.slug}/${pageData.title}`
                    };
                  }
                } catch (breadcrumbError) {
                  console.error('Failed to fetch breadcrumbs:', breadcrumbError);
                  // Fallback to simple path
                  currentPage = {
                    id: pageData.id,
                    title: pageData.title,
                    type: pageData.type,
                    path: `/${currentDrive?.slug}/${pageData.title}`
                  };
                }
              } else {
                // Fallback if API call fails
                currentPage = {
                  id: pageId,
                  title: pathParts[pathParts.length - 1].replace(/-/g, ' '),
                  type: 'DOCUMENT',
                  path: `/${currentDrive?.slug}/${pathParts[pathParts.length - 1].replace(/-/g, ' ')}`
                };
              }
            } catch (error) {
              console.error('Failed to fetch page data:', error);
              // Fallback
              currentPage = {
                id: pageId,
                title: pathParts[pathParts.length - 1].replace(/-/g, ' '),
                type: 'DOCUMENT',
                path: `/${currentDrive?.slug}/${pathParts[pathParts.length - 1].replace(/-/g, ' ')}`
              };
            }
          }
          
          // Build breadcrumbs using actual titles if available
          const breadcrumbs = [];
          if (currentDrive) {
            breadcrumbs.push(currentDrive.name);
          }
          if (currentPage && currentPage.path) {
            // Extract all folder/page names from the path for breadcrumbs
            const pathParts = currentPage.path.split('/').filter(Boolean);
            // Skip the drive slug (first part) as it's already added
            breadcrumbs.push(...pathParts.slice(1));
          }
          
          setLocationContext({
            currentPage,
            currentDrive,
            breadcrumbs
          });
        } catch (error) {
          console.error('Failed to extract location context:', error);
          setLocationContext(null);
        }
      } else {
        setLocationContext(null);
      }
    };

    extractLocationContext();
  }, [pathname]); // Only re-run when pathname changes, not on every drives refresh

  // Use the shared Chat instance from context - this is what enables state sharing!
  // Both AssistantChatTab and GlobalAssistantView will use the same Chat instance
  const {
    messages,
    sendMessage,
    status,
    error,
    regenerate,
    setMessages,
  } = useChat({ chat });

  // ✅ Removed setMessages sync effect - AI SDK v5 manages messages internally

  // Register streaming state with editing store (state-based protection)
  // Note: In AI SDK v5, status can be 'ready', 'submitted', 'streaming', or 'error'
  useEffect(() => {
    const componentId = `assistant-sidebar-${currentConversationId || 'init'}`;

    if (status === 'submitted' || status === 'streaming') {
      useEditingStore.getState().startStreaming(componentId, {
        conversationId: currentConversationId || undefined,
        componentName: 'AssistantChatTab',
      });
    } else {
      useEditingStore.getState().endStreaming(componentId);
    }

    // Cleanup on unmount
    return () => {
      useEditingStore.getState().endStreaming(componentId);
    };
  }, [status, currentConversationId]);

  // ✅ Combined scroll effects - use messages.length instead of messages array
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, status]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Load provider settings on mount
  useEffect(() => {
    const loadProviderSettings = async () => {
      try {
        const configResponse = await fetchWithAuth('/api/ai/settings');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);
      } catch (error) {
        console.error('Failed to load provider settings:', error);
      }
    };

    loadProviderSettings();
  }, []);
  
  // Listen for settings updates and reload provider settings
  useEffect(() => {
    const handleSettingsUpdate = async () => {
      try {
        const configResponse = await fetchWithAuth('/api/ai/settings');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);
      } catch (error) {
        console.error('Failed to reload settings:', error);
      }
    };

    window.addEventListener('ai-settings-updated', handleSettingsUpdate);
    return () => {
      window.removeEventListener('ai-settings-updated', handleSettingsUpdate);
    };
  }, []);

  // Use the context method to create new conversation
  const handleNewConversation = async () => {
    try {
      await createNewConversation();
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() || !currentConversationId) return;

    // Send the message with selected provider and model
    sendMessage(
      { text: input },
      {
        body: {
          agentRole: currentAgentRole,
          locationContext: locationContext || undefined,
          selectedProvider: providerSettings?.currentProvider,
          selectedModel: providerSettings?.currentModel,
        }
      }
    );
    setInput('');
    chatInputRef.current?.clear();
    setTimeout(scrollToBottom, 100);
  };

  // Edit message handler
  const handleEdit = async (messageId: string, newContent: string) => {
    if (!currentConversationId) return;

    try {
      await patch(`/api/ai_conversations/${currentConversationId}/messages/${messageId}`, {
        content: newContent,
      });

      // Refetch messages to get updated editedAt timestamp
      const messagesResponse = await fetchWithAuth(`/api/ai_conversations/${currentConversationId}/messages`);
      if (messagesResponse.ok) {
        const updatedMessages: UIMessage[] = await messagesResponse.json();
        setMessages(updatedMessages);
      }

      toast.success('Message updated successfully');
    } catch (error) {
      console.error('Failed to edit message:', error);
      toast.error('Failed to update message');
    }
  };

  // Delete message handler
  const handleDelete = async (messageId: string) => {
    if (!currentConversationId) return;

    try {
      await del(`/api/ai_conversations/${currentConversationId}/messages/${messageId}`);

      // Optimistically remove from UI
      setMessages(messages.filter(m => m.id !== messageId));

      toast.success('Message deleted');
    } catch (error) {
      console.error('Failed to delete message:', error);
      toast.error('Failed to delete message');
    }
  };

  // Retry handler - regenerate the last assistant message
  const handleRetry = async () => {
    if (!currentConversationId) return;

    // Before regenerating, clean up old assistant responses after the last user message
    const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');

    if (lastUserMsgIndex !== -1) {
      // Get all assistant messages after the last user message
      const assistantMessagesToDelete = messages
        .slice(lastUserMsgIndex + 1)
        .filter(m => m.role === 'assistant');

      // Delete them from the database
      for (const msg of assistantMessagesToDelete) {
        try {
          await del(`/api/ai_conversations/${currentConversationId}/messages/${msg.id}`);
        } catch (error) {
          console.error('Failed to delete old assistant message:', error);
        }
      }

      // Remove them from local state
      const filteredMessages = messages.filter(
        m => !assistantMessagesToDelete.some(toDelete => toDelete.id === m.id)
      );
      setMessages(filteredMessages);
    }

    // Now regenerate with a clean slate
    regenerate();
  };

  // Calculate the last assistant message ID for the retry button
  const lastAssistantMessageId = messages
    .filter(m => m.role === 'assistant')
    .slice(-1)[0]?.id;

  // Show loading state until chat is properly initialized
  if (!isInitialized) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex-grow flex items-center justify-center">
          <div className="flex items-center space-x-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading Global Assistant...</span>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="flex flex-col h-full">
      {/* Header with New Chat button */}
      <div className="flex items-center justify-between p-2 border-b border-gray-200 dark:border-[var(--separator)] bg-card">
        <span className="text-sm font-medium text-muted-foreground">Chat</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNewConversation}
          className="h-7 px-2"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full p-3" ref={scrollAreaRef}>
          <div className="space-y-3">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-muted-foreground text-xs text-center">
                <div>
                  <p className="font-medium">Global Assistant</p>
                  <p className="text-xs">
                    {locationContext
                      ? `Context-aware help for ${locationContext.currentPage?.title || locationContext.currentDrive?.name}`
                      : 'Ask me anything about your workspace'
                    }
                  </p>
                </div>
              </div>
            ) : (
              messages.map(message => (
                <CompactConversationMessageRenderer
                  key={message.id}
                  message={message}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onRetry={handleRetry}
                  isLastAssistantMessage={message.id === lastAssistantMessageId}
                />
              ))
            )}
            
            {status !== 'ready' && (
              <div className="p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <div className="text-xs font-medium mb-1 text-gray-700 dark:text-gray-300">
                  Global Assistant
                </div>
                <div className="flex items-center space-x-2 text-gray-500 text-xs">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
      </div>

      {/* Input Area */}
      <div className="border-t p-3 space-y-2">
        {error && showError && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs flex items-center justify-between">
            <p className="text-red-700 dark:text-red-300">
              {error.message?.includes('Unauthorized') || error.message?.includes('401') 
                ? 'Authentication failed. Please refresh the page and try again.'
                : (error.message?.toLowerCase().includes('rate') || 
                   error.message?.toLowerCase().includes('limit') || 
                   error.message?.includes('429') || 
                   error.message?.includes('402') ||
                   error.message?.includes('Failed after') ||
                   error.message?.includes('Provider returned error'))
                ? 'Free tier rate limit hit. Please try again in a few seconds or subscribe for premium models and access.'
                : 'Something went wrong. Please try again.'}
            </p>
            <button
              onClick={() => setShowError(false)}
              className="text-xs text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200 underline"
            >
              Clear
            </button>
          </div>
        )}
        
        {/* Role Selector Row */}
        <div className="px-1">
          <AgentRoleDropdownCompact
            currentRole={currentAgentRole}
            onRoleChange={setCurrentAgentRole}
            disabled={status === 'streaming'}
          />
        </div>
        
        {/* Input Form Row */}
        <div className="flex items-center space-x-2">
          <ChatInput
            ref={chatInputRef}
            value={input}
            onChange={setInput}
            onSendMessage={handleSendMessage}
            placeholder={locationContext 
              ? `Ask about ${locationContext.currentPage?.title || 'this page'}...`
              : "Ask about your workspace..."}
            driveId={locationContext?.currentDrive?.id}
            crossDrive={true}  // Allow searching across all drives in global assistant
          />
          <Button 
            onClick={handleSendMessage}
            disabled={status === 'streaming' || !input.trim() || !providerSettings?.isAnyProviderConfigured}
            size="sm"
            className="h-8 px-3"
          >
            {status === 'streaming' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AssistantChatTab;
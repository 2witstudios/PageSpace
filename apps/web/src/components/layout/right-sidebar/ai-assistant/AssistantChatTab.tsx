import React, { useEffect, useState, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import ChatInput, { ChatInputRef } from '@/components/messages/ChatInput';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, Plus } from 'lucide-react';
import { UIMessage, DefaultChatTransport } from 'ai';
import { CompactConversationMessageRenderer } from '@/components/ai/CompactConversationMessageRenderer';
import { AgentRole, AgentRoleUtils } from '@/lib/ai/agent-roles';
import { AgentRoleDropdownCompact } from '@/components/ai/AgentRoleDropdown';
import { conversationState } from '@/lib/ai/conversation-state';
import { useDriveStore } from '@/hooks/useDrive';
import { post, authFetch, fetchWithAuth } from '@/lib/auth-fetch';


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
  const searchParams = useSearchParams();
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [currentAgentRole, setCurrentAgentRole] = useState<AgentRole>(AgentRoleUtils.getDefaultRole());
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  
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

  // Get drives from store
  const { drives, fetchDrives } = useDriveStore();
  
  // Ensure drives are loaded
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);
  
  // Extract location context from pathname
  useEffect(() => {
    const extractLocationContext = async () => {
      const pathParts = pathname.split('/').filter(Boolean);
      
      if (pathParts.length >= 2 && pathParts[0] === 'dashboard') {
        const driveId = pathParts[1];
        
        try {
          let currentPage = null;
          let currentDrive = null;
          
          // Get drive information from store
          if (driveId) {
            const driveData = drives.find(d => d.id === driveId);
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
  }, [pathname, drives]);

  // Initialize conversation will be handled in the main initialization effect

  // AI SDK v5 useChat hook with conversation-specific endpoint
  const chatConfig = React.useMemo(() => {
    if (!currentConversationId) return null;
    
    return {
      id: currentConversationId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: `/api/ai_conversations/${currentConversationId}/messages`,
        fetch: (url, options) => {
          const urlString = url instanceof Request ? url.url : url.toString();
          return authFetch.fetch(urlString, options);
        },
      }),
      experimental_throttle: 50,
      onError: (error: Error) => {
        // Log full error details to console for debugging
        console.error('❌ Global Assistant: Chat error occurred:', error);
        console.error('Error details:', {
          message: error.message,
          stack: error.stack,
          name: error.name
        });
        
        if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
          console.error('🔒 Global Assistant: Authentication failed - user may need to log in again');
        }
        
        // Don't show technical details to users - error display is handled in UI
      },
    };
  }, [currentConversationId, initialMessages]);

  const { 
    messages, 
    sendMessage,
    setMessages,
    status,
    error,
  } = useChat(chatConfig || {});

  // Sync loaded messages with useChat hook after initialization
  React.useEffect(() => {
    if (isInitialized && initialMessages.length > 0 && messages.length === 0) {
      setMessages(initialMessages);
    }
  }, [isInitialized, initialMessages, messages.length, setMessages]);

  // Auto-scroll when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Auto-scroll when AI status changes (thinking/responding)
  useEffect(() => {
    scrollToBottom();
  }, [status]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Watch for URL changes and sync with conversation
  useEffect(() => {
    const urlConversationId = searchParams.get('c');
    
    if (urlConversationId && urlConversationId !== currentConversationId) {
      // URL has a different conversation - load it
      setCurrentConversationId(urlConversationId);
      conversationState.setActiveConversationId(urlConversationId);
      setIsInitialized(false); // Force re-initialization
    } else if (!urlConversationId && !currentConversationId) {
      // No URL param and no current conversation - get from cookie or most recent
      const cookieConversationId = conversationState.getActiveConversationId();
      if (cookieConversationId) {
        setCurrentConversationId(cookieConversationId);
      }
    }
  }, [searchParams, currentConversationId]);

  // Load conversation when ID changes
  useEffect(() => {
    const initializeChat = async () => {
      if (!currentConversationId) {
        // Try to get most recent conversation if no ID
        try {
          const globalConvResponse = await fetchWithAuth('/api/ai_conversations/global');
          
          if (globalConvResponse.ok) {
            const globalConversation = await globalConvResponse.json();
            if (globalConversation && globalConversation.id) {
              setCurrentConversationId(globalConversation.id);
              conversationState.setActiveConversationId(globalConversation.id);
              return; // Will trigger this effect again
            }
          }
          
          // No existing conversations - create first one
          const allConvResponse = await fetchWithAuth('/api/ai_conversations');
          if (allConvResponse.ok) {
            const convList = await allConvResponse.json();
            const globalConvs = convList.filter((c: { type: string }) => c.type === 'global');
            if (globalConvs.length === 0) {
              try {
                const newConversation = await post<{ id: string }>('/api/ai_conversations', { type: 'global' });
                setCurrentConversationId(newConversation.id);
                conversationState.setActiveConversationId(newConversation.id);
              } catch (error) {
                console.error('Failed to create conversation:', error);
              }
            }
          }
        } catch (error) {
          console.error('Failed to initialize conversation:', error);
        }
        
        setIsInitialized(true);
        return;
      }
      
      try {
        // Check multi-provider configuration
        const configResponse = await fetchWithAuth('/api/ai/settings');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);
        
        // Load messages for current conversation (with pagination)
        try {
          const messagesResponse = await fetchWithAuth(`/api/ai_conversations/${currentConversationId}/messages?limit=50`);
          if (messagesResponse.ok) {
            const messageData = await messagesResponse.json();
            // Handle both old format (array) and new format (object with messages and pagination)
            if (Array.isArray(messageData)) {
              setInitialMessages(messageData);
              setPagination(null);
            } else {
              setInitialMessages(messageData.messages || []);
              setPagination(messageData.pagination || null);
            }
          } else {
            setInitialMessages([]);
            setPagination(null);
          }
        } catch (error) {
          console.error('Failed to load conversation messages:', error);
          setInitialMessages([]);
        }
        
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize:', error);
        setInitialMessages([]);
        setIsInitialized(true);
      }
    };

    setIsInitialized(false);
    setInitialMessages([]);
    initializeChat();
  }, [currentConversationId]);
  
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

  const loadMoreMessages = async () => {
    if (!currentConversationId || !pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    try {
      const response = await fetchWithAuth(
        `/api/ai_conversations/${currentConversationId}/messages?limit=25&cursor=${pagination.nextCursor}&direction=before`
      );

      if (response.ok) {
        const messageData = await response.json();
        const olderMessages = Array.isArray(messageData) ? messageData : messageData.messages || [];

        // Prepend older messages to the existing ones
        setInitialMessages(prev => [...olderMessages, ...prev]);

        // Update pagination info
        if (!Array.isArray(messageData) && messageData.pagination) {
          setPagination(messageData.pagination);
        }
      }
    } catch (error) {
      console.error('Failed to load more messages:', error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleNewConversation = async () => {
    try {
      const newConversation = await post<{ id: string }>('/api/ai_conversations', { type: 'global' });

      if (newConversation) {
        setCurrentConversationId(newConversation.id);
        conversationState.setActiveConversationId(newConversation.id);
        setInitialMessages([]);
        setMessages([]); // Clear messages in the chat view

        // Update URL to reflect new conversation
        const url = new URL(window.location.href);
        url.searchParams.set('c', newConversation.id);
        window.history.pushState({}, '', url.toString());
      } else {
        throw new Error('Failed to create conversation');
      }
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
            {/* Load More Messages Button */}
            {pagination?.hasMore && messages.length > 0 && (
              <div className="flex justify-center py-2">
                <Button
                  onClick={loadMoreMessages}
                  disabled={isLoadingMore}
                  variant="outline"
                  size="sm"
                  className="text-xs"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    'Load older messages'
                  )}
                </Button>
              </div>
            )}

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
                <CompactConversationMessageRenderer key={message.id} message={message} />
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
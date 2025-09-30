import React, { useEffect, useState, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { useSearchParams, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import AiInput from '@/components/ai/AiInput';
import { ChatInputRef } from '@/components/messages/ChatInput';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, Settings, Plus, History } from 'lucide-react';
import { UIMessage, DefaultChatTransport } from 'ai';
import { MessageRenderer } from '@/components/ai/MessageRenderer';
import { AgentRole, AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RoleSelector } from '@/components/ai/RoleSelector';
import { conversationState } from '@/lib/ai/conversation-state';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';


interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: {
    pagespace?: { isConfigured: boolean; hasApiKey: boolean };
    openrouter: { isConfigured: boolean; hasApiKey: boolean };
    google: { isConfigured: boolean; hasApiKey: boolean };
    openai?: { isConfigured: boolean; hasApiKey: boolean };
    anthropic?: { isConfigured: boolean; hasApiKey: boolean };
    xai?: { isConfigured: boolean; hasApiKey: boolean };
    ollama?: { isConfigured: boolean; hasBaseUrl: boolean };
  };
  isAnyProviderConfigured: boolean;
}

interface Conversation {
  id: string;
  title: string;
  type: string;
  lastMessageAt: string;
  createdAt: string;
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

const GlobalAssistantView: React.FC = () => {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { rightSidebarOpen, toggleRightSidebar } = useLayoutStore();
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [showApiKeyInput, setShowApiKeyInput] = useState<boolean>(false);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [currentAgentRole, setCurrentAgentRole] = useState<AgentRole>(AgentRoleUtils.getDefaultRole());
  const [showError, setShowError] = useState(true);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
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
          let currentDrive = null;
          
          // Fetch drive information
          if (driveId) {
            // Get drive information from store
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
          
          // At drive root level, no specific page is selected
          setLocationContext({
            currentDrive,
            currentPage: null,
            breadcrumbs: currentDrive ? [currentDrive.name] : []
          });
        } catch (error) {
          console.error('Error extracting location context:', error);
          setLocationContext(null);
        }
      } else {
        // Dashboard level or other routes
        setLocationContext(null);
      }
    };

    extractLocationContext();
  }, [pathname, drives]);

  // Watch for URL parameter changes and load the appropriate conversation
  useEffect(() => {
    const loadConversationFromUrl = async () => {
      const urlConversationId = searchParams.get('c');
      const cookieConversationId = conversationState.getActiveConversationId();
      
      // If URL has a conversation ID, use it
      if (urlConversationId) {
        // Update cookie to match URL
        if (urlConversationId !== cookieConversationId) {
          conversationState.setActiveConversationId(urlConversationId);
        }
        
        // Only load if different from current
        if (urlConversationId !== currentConversationId) {
          setCurrentConversationId(urlConversationId);
          setIsInitialized(false); // Force re-initialization with new conversation
        }
      } else if (!currentConversationId) {
        // No URL param and no current conversation - check cookie or get most recent
        if (cookieConversationId) {
          setCurrentConversationId(cookieConversationId);
          // Update URL to reflect the conversation
          const url = new URL(window.location.href);
          url.searchParams.set('c', cookieConversationId);
          window.history.replaceState({}, '', url.toString());
        } else {
          // Try to get the most recent global conversation
          try {
            const response = await fetch('/api/ai_conversations/global');
            if (response.ok) {
              const conversation = await response.json();
              if (conversation && conversation.id) {
                setCurrentConversationId(conversation.id);
                conversationState.setActiveConversationId(conversation.id);
                // Update URL to reflect the conversation
                const url = new URL(window.location.href);
                url.searchParams.set('c', conversation.id);
                window.history.replaceState({}, '', url.toString());
              }
            }
          } catch (error) {
            console.error('Failed to fetch global conversation:', error);
          }
        }
      }
    };
    
    loadConversationFromUrl();
  }, [searchParams, currentConversationId]);

  // AI SDK v5 useChat hook with conversation-specific endpoint
  const chatConfig = React.useMemo(() => {
    if (!currentConversationId) return null;
    
    return {
      id: currentConversationId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: `/api/ai_conversations/${currentConversationId}/messages`,
        fetch: (url, options) => fetch(url, { 
          ...options, 
          credentials: 'include'
        }),
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

  // Auto-scroll when AI status changes
  useEffect(() => {
    scrollToBottom();
  }, [status]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Load conversation and provider settings when conversation ID changes
  useEffect(() => {
    const initializeChat = async () => {
      try {
        // Always check multi-provider configuration first
        const configResponse = await fetch('/api/ai/chat');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);
        
        if (!configData.isAnyProviderConfigured) {
          setShowApiKeyInput(true);
        }
        
        // If we have a conversation ID, load it
        if (currentConversationId) {
          try {
            const [conversationResponse, messagesResponse] = await Promise.all([
              fetch(`/api/ai_conversations/${currentConversationId}`),
              fetch(`/api/ai_conversations/${currentConversationId}/messages?limit=50`)
            ]);

            if (conversationResponse.ok && messagesResponse.ok) {
              const conversation = await conversationResponse.json();
              const messageData = await messagesResponse.json();
              // Handle both old format (array) and new format (object with messages and pagination)
              const existingMessages = Array.isArray(messageData) ? messageData : messageData.messages || [];

              setCurrentConversation(conversation);
              setInitialMessages(existingMessages);
              setMessages([]); // Clear current messages to force reload
            } else {
              // If conversation not found, clear it and try to find another
              console.error('Conversation not found:', currentConversationId);
              conversationState.setActiveConversationId(null);
              setCurrentConversationId(null);
              setCurrentConversation(null);
              setInitialMessages([]);
              
              // Clear URL parameter
              const url = new URL(window.location.href);
              url.searchParams.delete('c');
              window.history.replaceState({}, '', url.toString());
              
              // Try to load most recent conversation instead
              try {
                const response = await fetch('/api/ai_conversations/global');
                if (response.ok) {
                  const conversation = await response.json();
                  if (conversation && conversation.id) {
                    setCurrentConversationId(conversation.id);
                    conversationState.setActiveConversationId(conversation.id);
                    // Update URL
                    url.searchParams.set('c', conversation.id);
                    window.history.replaceState({}, '', url.toString());
                    // Don't set initialized here - let the effect re-run with new ID
                    return;
                  }
                }
              } catch (error) {
                console.error('Failed to fetch fallback conversation:', error);
              }
            }
          } catch (error) {
            console.error('Failed to load conversation:', error);
            setInitialMessages([]);
          }
        } else {
          // No current conversation ID - check if we need to create one
          try {
            // First try to get any existing global conversation
            const response = await fetch('/api/ai_conversations/global');
            if (response.ok) {
              const conversation = await response.json();
              if (conversation && conversation.id) {
                // Found an existing conversation (even if empty)
                setCurrentConversationId(conversation.id);
                setCurrentConversation(conversation);
                conversationState.setActiveConversationId(conversation.id);
                setInitialMessages([]);
                
                // Update URL
                const url = new URL(window.location.href);
                url.searchParams.set('c', conversation.id);
                window.history.replaceState({}, '', url.toString());
              } else {
                // No global conversation exists at all - create the first one
                const newConversation = await conversationState.createAndSetActiveConversation({
                  type: 'global',
                });
                setCurrentConversationId(newConversation.id);
                setCurrentConversation(newConversation);
                setInitialMessages([]);
                
                // Update URL
                const url = new URL(window.location.href);
                url.searchParams.set('c', newConversation.id);
                window.history.replaceState({}, '', url.toString());
              }
            } else {
              // API call failed - try to create a new conversation
              const newConversation = await conversationState.createAndSetActiveConversation({
                type: 'global',
              });
              setCurrentConversationId(newConversation.id);
              setCurrentConversation(newConversation);
              setInitialMessages([]);
              
              // Update URL
              const url = new URL(window.location.href);
              url.searchParams.set('c', newConversation.id);
              window.history.replaceState({}, '', url.toString());
            }
          } catch (error) {
            console.error('Failed to initialize conversation:', error);
            // Even on error, we should exit loading state
          }
        }
        
        // Always set initialized at the end
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize global assistant:', error);
        setInitialMessages([]);
        // Always set initialized even on error to exit loading state
        setIsInitialized(true);
      }
    };

    // Initialize on mount or when conversation changes
    if (!isInitialized) {
      initializeChat();
    }
  }, [currentConversationId, setMessages, isInitialized]);

  const handleNewConversation = async () => {
    try {
      const newConversation = await conversationState.startNewConversation();
      setCurrentConversationId(newConversation.id);
      setCurrentConversation(newConversation);
      setInitialMessages([]);
      
      // Update URL to reflect new conversation
      const url = new URL(window.location.href);
      url.searchParams.set('c', newConversation.id);
      window.history.pushState({}, '', url.toString());
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  };

  const handleOpenSettings = () => {
    // Open right sidebar if it's closed
    if (!rightSidebarOpen) {
      toggleRightSidebar();
    }
    // Set the active tab to settings
    localStorage.setItem('globalAssistantActiveTab', 'settings');
    // Trigger a storage event to update the sidebar if it's already open
    window.dispatchEvent(new Event('storage'));
  };

  const handleOpenHistory = () => {
    // Open right sidebar if it's closed
    if (!rightSidebarOpen) {
      toggleRightSidebar();
    }
    // Set the active tab to history
    localStorage.setItem('globalAssistantActiveTab', 'history');
    // Trigger a storage event to update the sidebar if it's already open
    window.dispatchEvent(new Event('storage'));
  };

  const handleSendMessage = async () => {
    if (!input.trim()) return;

    // If no conversation exists yet, create one first
    if (!currentConversationId) {
      try {
        const newConversation = await conversationState.createAndSetActiveConversation({
          type: 'global',
        });
        setCurrentConversationId(newConversation.id);
        setCurrentConversation(newConversation);
        setInitialMessages([]);
        
        // Update URL
        const url = new URL(window.location.href);
        url.searchParams.set('c', newConversation.id);
        window.history.replaceState({}, '', url.toString());
        
        // Wait a bit for the chat config to update with the new conversation
        setTimeout(() => {
          sendMessage(
            { text: input },
            {
              body: {
                agentRole: currentAgentRole,
                locationContext: locationContext || undefined,
              }
            }
          );
          setInput('');
          chatInputRef.current?.clear();
          setTimeout(scrollToBottom, 100);
        }, 100);
      } catch (error) {
        console.error('Failed to create conversation:', error);
      }
      return;
    }

    // Send the message with location context
    sendMessage(
      { text: input },
      {
        body: {
          agentRole: currentAgentRole,
          locationContext: locationContext || undefined,
        }
      }
    );
    setInput('');
    chatInputRef.current?.clear();
    setTimeout(scrollToBottom, 100);
  };
  

  // Show loading skeleton while initializing
  const isLoading = !isInitialized;

  if (showApiKeyInput && !providerSettings?.isAnyProviderConfigured) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex-grow flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Settings className="h-5 w-5" />
                <span>AI Provider Setup Required</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You need to configure an AI provider before you can start chatting.
                Click the button below to open settings and add your API keys.
              </p>
              
              <Button 
                onClick={handleOpenSettings}
                className="w-full"
              >
                <Settings className="h-4 w-4 mr-2" />
                Open Settings
              </Button>
              
              <div className="text-xs text-muted-foreground text-center">
                You can configure OpenRouter or Google AI providers.
                Your API keys are encrypted and stored securely.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with Global Assistant title, conversation info and action buttons */}
      <div className="flex items-center justify-between p-4 border-b border-[var(--separator)]">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium">
            Global Assistant: {currentConversation?.title || 'New Conversation'}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenSettings}
            className="h-8 w-8"
            title="Open Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenHistory}
            className="h-8 w-8"
            title="View History"
          >
            <History className="h-4 w-4" />
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleNewConversation}
            className="flex items-center space-x-2"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New</span>
          </Button>
        </div>
      </div>

      {/* Role Selector Header */}
      <div className="flex items-center p-4 border-b border-[var(--separator)]">
        <RoleSelector
          currentRole={currentAgentRole}
          onRoleChange={setCurrentAgentRole}
          disabled={status === 'streaming'}
          size="sm"
        />
      </div>

      {/* Messages Area */}
      <div className="flex-1 min-h-0 overflow-hidden px-4">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="max-w-4xl mx-auto w-full">
            <div className="space-y-4 pr-4">
              {isLoading ? (
                // Loading skeleton
                <div className="space-y-4">
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    <div className="flex items-center space-x-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Loading Global Assistant...</span>
                    </div>
                  </div>
                  {/* Skeleton messages */}
                  <div className="space-y-3">
                    <div className="p-3 rounded-lg bg-gray-100 dark:bg-gray-800 mr-8 animate-pulse">
                      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2"></div>
                      <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
                    </div>
                    <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 ml-8 animate-pulse">
                      <div className="h-4 bg-blue-200 dark:bg-blue-700 rounded w-2/3 mb-2"></div>
                      <div className="h-3 bg-blue-200 dark:bg-blue-700 rounded w-1/3"></div>
                    </div>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-muted-foreground">
                  <p>Welcome to your Global Assistant! Ask me anything about your workspace.</p>
                </div>
              ) : (
                messages.map(message => (
                  <MessageRenderer key={message.id} message={message} />
                ))
              )}
              
              {status !== 'ready' && !isLoading && (
                <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 mr-8">
                  <div className="text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    Global Assistant
                  </div>
                  <div className="flex items-center space-x-2 text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Thinking...</span>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Input Area */}
      <div className="border-t border-[var(--separator)] p-4">
        <div className="max-w-4xl mx-auto w-full">
          {error && showError && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-center justify-between">
              <p className="text-sm text-red-700 dark:text-red-300">
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
                className="text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200 underline"
              >
                Clear
              </button>
            </div>
          )}
          
          <div className="flex space-x-2">
            <AiInput
              ref={chatInputRef}
              value={input}
              onChange={setInput}
              onSendMessage={handleSendMessage}
              placeholder={isLoading ? "Loading..." : "Ask about your workspace..."}
              driveId={locationContext?.currentDrive?.id}
              crossDrive={true}  // Allow searching across all drives in global assistant
            />
            <Button
              onClick={handleSendMessage}
              disabled={status === 'streaming' || !input.trim() || !providerSettings?.isAnyProviderConfigured || isLoading}
              size="icon"
            >
              {status === 'streaming' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GlobalAssistantView;
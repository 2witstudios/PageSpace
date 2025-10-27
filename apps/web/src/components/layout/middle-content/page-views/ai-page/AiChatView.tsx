import { TreePage, usePageTree } from '@/hooks/usePageTree';
import React, { useEffect, useState, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Save } from 'lucide-react';
import AiInput from '@/components/ai/AiInput';
import { ChatInputRef } from '@/components/messages/ChatInput';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Send, Settings, MessageSquare, StopCircle, History, Plus } from 'lucide-react';
import { UIMessage, DefaultChatTransport } from 'ai';
import { useEditingStore } from '@/stores/useEditingStore';
import { ConversationMessageRenderer } from '@/components/ai/ConversationMessageRenderer';
import { buildPagePath } from '@/lib/tree/tree-utils';
import { useDriveStore } from '@/hooks/useDrive';
import { getBackendProvider } from '@/lib/ai/ai-providers-config';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import AgentSettingsTab, { AgentSettingsTabRef } from '@/components/ai/AgentSettingsTab';
import AgentHistoryTab from '@/components/ai/AgentHistoryTab';
import { fetchWithAuth, patch, del } from '@/lib/auth-fetch';
import useSWR, { mutate } from 'swr';

interface AiChatViewProps {
    page: TreePage;
}

// Using centralized AI providers configuration

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
    glm?: { isConfigured: boolean; hasApiKey: boolean };
  };
  isAnyProviderConfigured: boolean;
}

const AiChatView: React.FC<AiChatViewProps> = ({ page }) => {
  const params = useParams();
  const driveId = params.driveId as string;
  const { drives } = useDriveStore();
  const { tree } = usePageTree(driveId);
  
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('pagespace');
  const [selectedModel, setSelectedModel] = useState<string>('qwen/qwen3-coder:free');
  const [openRouterApiKey, setOpenRouterApiKey] = useState<string>('');
  const [googleApiKey, setGoogleApiKey] = useState<string>('');
  const [showApiKeyInput, setShowApiKeyInput] = useState<boolean>(false);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [agentConfig, setAgentConfig] = useState<{
    systemPrompt: string;
    enabledTools: string[];
    availableTools: Array<{ name: string; description: string }>;
  } | null>(null);
  const [showError, setShowError] = useState(true);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [editVersion, setEditVersion] = useState(0); // Track edit version for forcing re-renders

  // Conversation state
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);

  // SWR for conversation list with caching and auto-revalidation
  const conversationsKey = `/api/agents/${page.id}/conversations`;
  const { data: conversationsData, isLoading: isLoadingConversations } = useSWR(
    // Only fetch when History tab is active
    activeTab === 'history' ? conversationsKey : null,
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load conversations');
      return response.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 5000, // Dedupe requests within 5 seconds
    }
  );

  // Transform conversations data with proper date parsing
  const conversations = React.useMemo(() => {
    if (!conversationsData?.conversations) return [];
    return conversationsData.conversations.map((conv: {
      id: string;
      title: string;
      preview: string;
      createdAt: string;
      updatedAt: string;
      messageCount: number;
      lastMessage: { role: string; timestamp: string };
    }) => ({
      ...conv,
      createdAt: new Date(conv.createdAt),
      updatedAt: new Date(conv.updatedAt),
      lastMessage: {
        ...conv.lastMessage,
        timestamp: new Date(conv.lastMessage.timestamp),
      },
    }));
  }, [conversationsData]);

  const { user } = useAuth();
  
  // Refs for auto-scrolling and chat input
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const agentSettingsRef = useRef<AgentSettingsTabRef>(null);
  
  // Auto-scroll to bottom function
  const scrollToBottom = () => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  };

  // AI SDK v5 useChat hook with proper persistence patterns
  // Use conditional rendering to only initialize when messages are loaded
  const chatConfig = React.useMemo(() => ({
    id: page.id, // Use pageId as chatId for AI SDK v5 persistence
    messages: initialMessages, // AI SDK v5 pattern - passed once, managed internally
    transport: new DefaultChatTransport({
      api: '/api/ai/chat',
      fetch: (url, options) => {
        const urlString = url instanceof Request ? url.url : url.toString();
        return fetchWithAuth(urlString, options);
      },
    }),
    experimental_throttle: 50, // Throttle updates for better performance during streaming
    onError: (error: Error) => {
      // Log full error details to console for debugging
      console.error('❌ AiChatView: Chat error occurred:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });

      // Handle authentication errors specifically
      if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
        console.error('🔒 AiChatView: Authentication failed - user may need to log in again');
      }

      // Don't show technical details to users - error display is handled in UI
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [page.id]); // initialMessages intentionally excluded - passed once for AI SDK v5 pattern

  const {
    messages,
    sendMessage,
    status,
    error,
    regenerate,
    setMessages,
    stop,
  } = useChat(chatConfig);

  // ✅ Removed setMessages sync effect - AI SDK v5 manages messages internally
  // No need to manually sync after initialization

  // Message action handlers (defined after useChat so we have access to messages, setMessages, regenerate)
  const handleEdit = async (messageId: string, newContent: string) => {
    try {
      // Persist to backend (already handles structured content correctly)
      await patch(`/api/ai/chat/messages/${messageId}`, { content: newContent });

      // Refetch messages and force remount - MUST include conversationId to maintain isolation
      const messagesResponse = await fetchWithAuth(
        `/api/ai/chat/messages?pageId=${page.id}&conversationId=${currentConversationId}`
      );
      if (messagesResponse.ok) {
        const freshMessages: UIMessage[] = await messagesResponse.json();
        setMessages(freshMessages);
        setEditVersion(v => v + 1); // Force re-render with new key
      }

      toast.success('Message updated successfully');
    } catch (error) {
      console.error('Failed to edit message:', error);
      toast.error('Failed to edit message');
      throw error;
    }
  };

  const handleDelete = async (messageId: string) => {
    try {
      await del(`/api/ai/chat/messages/${messageId}`);

      // Remove from UI immediately (optimistic update)
      setMessages(messages.filter(m => m.id !== messageId));

      toast.success('Message deleted');
    } catch (error) {
      console.error('Failed to delete message:', error);
      toast.error('Failed to delete message');
      throw error;
    }
  };

  const handleRetry = async () => {
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
          await del(`/api/ai/chat/messages/${msg.id}`);
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

  // Conversation management functions (wrapped in useCallback for stable references)

  const loadConversation = React.useCallback(async (conversationId: string) => {
    try {
      const response = await fetchWithAuth(
        `/api/agents/${page.id}/conversations/${conversationId}/messages`
      );
      if (response.ok) {
        const data = await response.json();
        setMessages(data.messages);
        setCurrentConversationId(conversationId);
        setActiveTab('chat'); // Switch to chat tab
        toast.success('Conversation loaded');
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
      toast.error('Failed to load conversation');
    }
  }, [page.id, setMessages, setActiveTab]);

  const createNewConversation = React.useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/api/agents/${page.id}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.ok) {
        const data = await response.json();
        setCurrentConversationId(data.conversationId);
        setMessages([]); // Clear chat
        setActiveTab('chat');
        // Invalidate SWR cache to reload conversations list
        mutate(conversationsKey);
        toast.success('New conversation started');
      }
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast.error('Failed to create new conversation');
    }
  }, [page.id, setMessages, setActiveTab, conversationsKey]);

  const deleteConversation = React.useCallback(async (conversationId: string) => {
    try {
      const response = await fetchWithAuth(
        `/api/agents/${page.id}/conversations/${conversationId}`,
        { method: 'DELETE' }
      );
      if (response.ok) {
        // If deleting current conversation, clear messages
        if (conversationId === currentConversationId) {
          setMessages([]);
          setCurrentConversationId(null);
        }
        // Invalidate SWR cache to reload conversations list
        mutate(conversationsKey);
        toast.success('Conversation deleted');
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      toast.error('Failed to delete conversation');
    }
  }, [page.id, currentConversationId, setMessages, conversationsKey]);

  // Determine last assistant message for retry button visibility
  const lastAssistantMessageId = messages
    .filter(m => m.role === 'assistant')
    .slice(-1)[0]?.id;

  // Register streaming state with editing store (state-based protection)
  // Note: In AI SDK v5, status can be 'ready', 'submitted', 'streaming', or 'error'
  useEffect(() => {
    const componentId = `ai-chat-${page.id}`;

    if (status === 'submitted' || status === 'streaming') {
      useEditingStore.getState().startStreaming(componentId, {
        pageId: page.id,
        componentName: 'AiChatView',
      });
    } else {
      useEditingStore.getState().endStreaming(componentId);
    }

    // Cleanup on unmount
    return () => {
      useEditingStore.getState().endStreaming(componentId);
    };
  }, [status, page.id]);

  // ✅ Combined scroll effects - use messages.length instead of messages array
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, status]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Check user permissions
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;

      try {
        const response = await fetchWithAuth(`/api/pages/${page.id}/permissions/check`);
        if (response.ok) {
          const permissions = await response.json();
          setIsReadOnly(!permissions.canEdit);
        }
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    };

    checkPermissions();
  }, [user?.id, page.id]);

  // Load existing messages and provider settings on component mount
  useEffect(() => {
    const initializeChat = async () => {
      try {
        // Parallelize API calls for faster loading
        const [configResponse, agentConfigResponse] = await Promise.all([
          fetchWithAuth(`/api/ai/chat?pageId=${page.id}`),
          fetchWithAuth(`/api/pages/${page.id}/agent-config`)
        ]);

        // Process config data
        if (configResponse.ok) {
          const configData: ProviderSettings = await configResponse.json();
          setProviderSettings(configData);

          // Set current provider and model from server (now includes page-specific settings)
          setSelectedProvider(configData.currentProvider);
          setSelectedModel(configData.currentModel);

          // Show API key input if no providers are configured
          if (!configData.isAnyProviderConfigured) {
            setShowApiKeyInput(true);
          }
        }

        // ✅ Conversation Fix: Always create a new conversation on page load
        // This prevents loading old messages from default conversation (conv_default_pageId)
        // Users can access old conversations via the History tab
        const newConvResponse = await fetchWithAuth(`/api/agents/${page.id}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        if (newConvResponse.ok) {
          const newConvData = await newConvResponse.json();
          setCurrentConversationId(newConvData.conversationId);

          // Start with empty messages (fresh conversation)
          setInitialMessages([]);
          setMessages([]);
        } else {
          // Fallback: if conversation creation fails, start with empty state
          setInitialMessages([]);
          setMessages([]);
        }

        // Process agent config data
        if (agentConfigResponse.ok) {
          const agentConfigData = await agentConfigResponse.json();
          setAgentConfig(agentConfigData);

          // Set provider and model from page config if available
          if (agentConfigData.aiProvider) {
            setSelectedProvider(agentConfigData.aiProvider);
          }
          if (agentConfigData.aiModel) {
            setSelectedModel(agentConfigData.aiModel);
          }
        }

        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize chat:', error);
        setInitialMessages([]);
        setMessages([]);
        setIsInitialized(true);
      }
    };

    // Reset initialization state when page changes
    setIsInitialized(false);
    setInitialMessages([]);
    setCurrentConversationId(null); // Reset conversation on page change
    initializeChat();
  }, [page.id, setMessages]); // setMessages from useChat is stable

  const handleApiKeySubmit = () => {
    const hasKey = selectedProvider === 'openrouter' ? openRouterApiKey.trim() : googleApiKey.trim();
    if (hasKey && providerSettings) {
      // Update provider settings to reflect the new configuration
      const updatedSettings = {
        ...providerSettings,
        providers: {
          ...providerSettings.providers,
          [selectedProvider]: {
            isConfigured: true,
            hasApiKey: true,
          },
        },
        isAnyProviderConfigured: true,
      };
      setProviderSettings(updatedSettings);
      setShowApiKeyInput(false);
    }
  };
  
  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    // Note: Model selection is now handled by AgentSettingsTab
    // which will fetch dynamic models for Ollama/LM Studio
  };
  
  const handleModelChange = (model: string) => {
    setSelectedModel(model);
  };
  
  const isProviderConfigured = (provider: string): boolean => {
    // PageSpace provider is always configured if it has an API key
    if (provider === 'pagespace') {
      return providerSettings?.providers.pagespace?.isConfigured || false;
    }
    // GLM provider should check its own configuration directly
    // (not the OpenAI configuration, even though GLM uses OpenAI-compatible backend)
    if (provider === 'glm') {
      return providerSettings?.providers.glm?.isConfigured || false;
    }
    // Map UI provider to backend provider for checking configuration
    const backendProvider = getBackendProvider(provider);
    // For openrouter_free, check the openrouter configuration
    if (backendProvider === 'openrouter') {
      return providerSettings?.providers.openrouter?.isConfigured || false;
    }
    return providerSettings?.providers[backendProvider as keyof typeof providerSettings.providers]?.isConfigured || false;
  };


  // Show loading skeleton while initializing, but don't block the UI
  const isLoading = !isInitialized;

  if (showApiKeyInput && !providerSettings?.isAnyProviderConfigured) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex-grow flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Settings className="h-5 w-5" />
                <span>AI Provider Setup</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose an AI provider and enter your API key to start chatting. 
                Your keys are encrypted and stored securely.
              </p>
              
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Provider</label>
                  <Select value={selectedProvider} onValueChange={handleProviderChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                      <SelectItem value="google">Google AI</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="space-y-2">
                  <label className="text-sm font-medium">API Key</label>
                  {selectedProvider === 'openrouter' ? (
                    <Input
                      type="password"
                      placeholder="Enter your OpenRouter API key"
                      value={openRouterApiKey}
                      onChange={(e) => setOpenRouterApiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleApiKeySubmit();
                        }
                      }}
                    />
                  ) : (
                    <Input
                      type="password"
                      placeholder="Enter your Google AI API key"
                      value={googleApiKey}
                      onChange={(e) => setGoogleApiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleApiKeySubmit();
                        }
                      }}
                    />
                  )}
                </div>
                
                <Button 
                  onClick={handleApiKeySubmit}
                  disabled={selectedProvider === 'openrouter' ? !openRouterApiKey.trim() : !googleApiKey.trim()}
                  className="w-full"
                >
                  Save API Key
                </Button>
              </div>
              
              <div className="text-xs text-muted-foreground">
                {selectedProvider === 'openrouter' ? (
                  <>
                    Get your API key from{' '}
                    <a 
                      href="https://openrouter.ai/keys" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      openrouter.ai/keys
                    </a>
                  </>
                ) : (
                  <>
                    Get your API key from{' '}
                    <a 
                      href="https://aistudio.google.com/app/apikey" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      Google AI Studio
                    </a>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
        <div className="p-4 border-b border-[var(--separator)]">
          <div className="flex items-center justify-between">
            <TabsList className="grid grid-cols-3 max-w-lg">
              <TabsTrigger value="chat" className="flex items-center space-x-2">
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">Chat</span>
              </TabsTrigger>
              <TabsTrigger value="history" className="flex items-center space-x-2">
                <History className="h-4 w-4" />
                <span className="hidden sm:inline">History</span>
              </TabsTrigger>
              <TabsTrigger value="settings" className="flex items-center space-x-2">
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Settings</span>
              </TabsTrigger>
            </TabsList>

            {/* New Chat Button - Only show when Chat tab is active */}
            {activeTab === 'chat' && (
              <Button
                variant="outline"
                size="sm"
                onClick={createNewConversation}
                className="flex items-center space-x-2"
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New Chat</span>
              </Button>
            )}

            {/* Save Settings Button - Only show when Settings tab is active */}
            {activeTab === 'settings' && (
              <Button
                onClick={() => agentSettingsRef.current?.submitForm()}
                disabled={agentSettingsRef.current?.isSaving || false}
                className="min-w-[100px] sm:min-w-[120px]"
              >
                {agentSettingsRef.current?.isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    <span className="hidden sm:inline">Saving...</span>
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Save Settings</span>
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Chat Tab */}
        <TabsContent value="chat" className="flex flex-col flex-1 overflow-hidden">

      {/* Messages Area - Apply centering pattern */}
      <div className="flex-grow overflow-hidden p-4">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="max-w-4xl mx-auto w-full">
            <div className="space-y-4 pr-1 sm:pr-4">
              {isLoading ? (
                // Loading skeleton
                <div className="space-y-4">
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    <div className="flex items-center space-x-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Loading conversation...</span>
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
                  <p>Start a conversation with the AI assistant</p>
                </div>
              ) : (
                messages.map(message => (
                  <ConversationMessageRenderer
                    key={`${message.id}-${editVersion}`}
                    message={message}
                    onEdit={!isReadOnly ? handleEdit : undefined}
                    onDelete={!isReadOnly ? handleDelete : undefined}
                    onRetry={!isReadOnly ? handleRetry : undefined}
                    isLastAssistantMessage={message.id === lastAssistantMessageId}
                  />
                ))
              )}
              
              {status !== 'ready' && !isLoading && (
                <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 mr-8">
                  <div className="text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                    Assistant
                  </div>
                  <div className="flex items-center space-x-2 text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Thinking...</span>
                  </div>
                </div>
              )}
              
              {/* Invisible element to mark the bottom for scrolling */}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Input Area - Apply centering pattern */}
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
              onSendMessage={() => {
                if (isReadOnly) {
                  toast.error('You do not have permission to send messages in this AI chat');
                  return;
                }
                if (input.trim()) {
                  // Get current drive information
                  const currentDrive = drives.find(d => d.id === driveId);
                  // Build page path context
                  const pagePathInfo = buildPagePath(tree, page.id, driveId);

                  sendMessage(
                    { text: input },
                    {
                      body: {
                        chatId: page.id,
                        conversationId: currentConversationId, // Include conversation session ID
                        selectedProvider: selectedProvider, // Don't convert - send UI provider directly
                        selectedModel,
                        openRouterApiKey: openRouterApiKey || undefined,
                        googleApiKey: googleApiKey || undefined,
                        pageContext: {
                          pageId: page.id,
                          pageTitle: page.title,
                          pageType: page.type,
                          pagePath: pagePathInfo?.path || `/${driveId}/${page.title}`,
                          parentPath: pagePathInfo?.parentPath || `/${driveId}`,
                          breadcrumbs: pagePathInfo?.breadcrumbs || [driveId, page.title],
                          driveId: currentDrive?.id,
                          driveName: currentDrive?.name || driveId,
                          driveSlug: currentDrive?.slug,
                        },
                      }
                    }
                  );
                  setInput('');
                  chatInputRef.current?.clear();
                  // Scroll to bottom after sending message
                  setTimeout(scrollToBottom, 100);
                }
              }}
              placeholder={isReadOnly ? "View only - cannot send messages" : (isLoading ? "Loading..." : "Message AI...")}
              driveId={driveId}
            />
            {status === 'streaming' || status === 'submitted' ? (
              <Button
                onClick={() => stop()}
                variant="destructive"
                size="icon"
                title="Stop generating"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={() => {
                  if (isReadOnly) {
                    toast.error('You do not have permission to send messages in this AI chat');
                    return;
                  }
                  if (input.trim()) {
                    // Get current drive information
                    const currentDrive = drives.find(d => d.id === driveId);
                    // Build page path context
                    const pagePathInfo = buildPagePath(tree, page.id, driveId);

                    sendMessage(
                      { text: input },
                      {
                        body: {
                          chatId: page.id,
                          conversationId: currentConversationId, // Include conversation session ID
                          selectedProvider: selectedProvider,
                          selectedModel,
                          openRouterApiKey: openRouterApiKey || undefined,
                          googleApiKey: googleApiKey || undefined,
                          pageContext: {
                            pageId: page.id,
                            pageTitle: page.title,
                            pageType: page.type,
                            pagePath: pagePathInfo?.path || `/${driveId}/${page.title}`,
                            parentPath: pagePathInfo?.parentPath || `/${driveId}`,
                            breadcrumbs: pagePathInfo?.breadcrumbs || [driveId, page.title],
                            driveId: currentDrive?.id,
                            driveName: currentDrive?.name || driveId,
                            driveSlug: currentDrive?.slug,
                          },
                        }
                      }
                    );
                    setInput('');
                    chatInputRef.current?.clear();
                    // Scroll to bottom after sending message
                    setTimeout(scrollToBottom, 100);
                  }
                }}
                disabled={!input.trim() || !providerSettings?.isAnyProviderConfigured || isLoading || isReadOnly}
                size="icon"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
      
          {/* Read-only indicator */}
          {isReadOnly && (
            <div className="mt-2 mx-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-2">
              <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
                🔒 View Only - You do not have permission to send messages in this AI chat
              </p>
            </div>
          )}
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="flex-1 overflow-hidden">
          <AgentHistoryTab
            conversations={conversations}
            currentConversationId={currentConversationId}
            onSelectConversation={loadConversation}
            onCreateNew={createNewConversation}
            onDeleteConversation={deleteConversation}
            isLoading={isLoadingConversations}
          />
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="flex-1 overflow-auto">
          <AgentSettingsTab
            ref={agentSettingsRef}
            pageId={page.id}
            config={agentConfig}
            onConfigUpdate={setAgentConfig}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onProviderChange={handleProviderChange}
            onModelChange={handleModelChange}
            isProviderConfigured={isProviderConfigured}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AiChatView;
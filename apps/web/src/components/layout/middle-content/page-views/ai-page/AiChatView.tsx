import { TreePage, usePageTree } from '@/hooks/usePageTree';
import React, { useEffect, useState, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Save } from 'lucide-react';
import ChatInput, { ChatInputRef } from '@/components/messages/ChatInput';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Send, Settings } from 'lucide-react';
import { UIMessage, DefaultChatTransport } from 'ai';
import { MessageRenderer } from '@/components/ai/MessageRenderer';
import { buildPagePath } from '@/lib/tree/tree-utils';
import { useDriveStore } from '@/hooks/useDrive';
import { AgentRole, AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RoleSelector } from '@/components/ai/RoleSelector';
import { AI_PROVIDERS, getBackendProvider } from '@/lib/ai/ai-providers-config';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';

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
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [currentAgentRole, setCurrentAgentRole] = useState<AgentRole>(AgentRoleUtils.getDefaultRole());
  const [showError, setShowError] = useState(true);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const { user } = useAuth();
  
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

  // AI SDK v5 useChat hook with proper persistence patterns
  // Use conditional rendering to only initialize when messages are loaded
  const chatConfig = React.useMemo(() => ({
    id: page.id, // Use pageId as chatId for AI SDK v5 persistence
    messages: initialMessages, // AI SDK v5 pattern for loading existing messages
    transport: new DefaultChatTransport({
      api: '/api/ai/chat',
      fetch: (url, options) => fetch(url, { 
        ...options, 
        credentials: 'include' // Ensures authentication cookies are sent
      }),
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
  }), [page.id, initialMessages]);

  const { 
    messages, 
    sendMessage,
    setMessages,
    status,
    error,
  } = useChat(chatConfig);

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

  // Check user permissions
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;
      
      try {
        const response = await fetch(`/api/pages/${page.id}/permissions/check`);
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
        const [configResponse, messagesResponse] = await Promise.all([
          fetch(`/api/ai/chat?pageId=${page.id}`),
          fetch(`/api/ai/chat/messages?pageId=${page.id}`)
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
        
        // Process messages data
        if (messagesResponse.ok) {
          const existingMessages: UIMessage[] = await messagesResponse.json();
          setInitialMessages(existingMessages);
        } else {
          setInitialMessages([]);
        }
        
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize chat:', error);
        setInitialMessages([]);
        setIsInitialized(true);
      }
    };

    // Reset initialization state when page changes
    setIsInitialized(false);
    setInitialMessages([]);
    initializeChat();
  }, [page.id]);

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
    // Set default model for the selected provider
    const defaultModel = Object.keys(AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS].models)[0];
    setSelectedModel(defaultModel);
    setHasUnsavedChanges(true);
  };
  
  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    setHasUnsavedChanges(true);
  };
  
  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          provider: selectedProvider, // Don't convert - save UI provider directly
          model: selectedModel,
        }),
      });
      
      if (response.ok) {
        setHasUnsavedChanges(false);
        console.log('✅ Page AI settings saved successfully');
      } else {
        console.error('Failed to save page AI settings');
      }
    } catch (error) {
      console.error('Error saving page AI settings:', error);
    } finally {
      setIsSaving(false);
    }
  };
  
  const isProviderConfigured = (provider: string): boolean => {
    // PageSpace provider is always configured if it has an API key
    if (provider === 'pagespace') {
      return providerSettings?.providers.pagespace?.isConfigured || false;
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
      {/* Chat Header - Keep full width */}
      <div className="flex items-center justify-between p-4 border-b bg-card">
        <div className="flex items-center space-x-3">
          {/* Agent Role Selector */}
          <RoleSelector
            currentRole={currentAgentRole}
            onRoleChange={setCurrentAgentRole}
            disabled={status === 'streaming'}
            size="sm"
          />
          
          {/* Provider Selector */}
          <div className="flex items-center space-x-2">
            <Select value={selectedProvider} onValueChange={handleProviderChange}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(AI_PROVIDERS).map(([key, provider]) => {
                  const configured = isProviderConfigured(key);
                  return (
                    <SelectItem key={key} value={key} disabled={!configured}>
                      <div className="flex items-center space-x-2">
                        <span>{provider.name}</span>
                        {!configured && <span className="text-xs text-muted-foreground">(Setup Required)</span>}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            
            {/* Model Selector */}
            <Select value={selectedModel} onValueChange={handleModelChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{AI_PROVIDERS[selectedProvider as keyof typeof AI_PROVIDERS]?.name} Models</SelectLabel>
                  {Object.entries(AI_PROVIDERS[selectedProvider as keyof typeof AI_PROVIDERS]?.models || {}).map(([key, name]) => (
                    <SelectItem key={key} value={key}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            
            {/* Save Settings Button */}
            {hasUnsavedChanges && (
              <Button 
                onClick={handleSaveSettings} 
                disabled={isSaving}
                size="sm"
                variant="outline"
                className="ml-2"
              >
                <Save className="h-4 w-4 mr-1" />
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            )}
          </div>
        </div>
        
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowApiKeyInput(true)}
        >
          <Settings className="h-4 w-4 mr-2" />
          Settings
        </Button>
      </div>

      {/* Messages Area - Apply centering pattern */}
      <div className="flex-grow overflow-hidden p-4">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="max-w-4xl mx-auto w-full">
            <div className="space-y-4 pr-4">
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
                  <MessageRenderer key={message.id} message={message} />
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
      <div className="border-t p-4">
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
            <ChatInput
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
                        agentRole: currentAgentRole,
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
                        agentRole: currentAgentRole,
                      }
                    }
                  );
                  setInput('');
                  chatInputRef.current?.clear();
                  // Scroll to bottom after sending message
                  setTimeout(scrollToBottom, 100);
                }
              }}
              disabled={status === 'streaming' || !input.trim() || !providerSettings?.isAnyProviderConfigured || isLoading || isReadOnly}
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
      
      {/* Read-only indicator */}
      {isReadOnly && (
        <div className="mt-2 mx-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-2">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
            🔒 View Only - You do not have permission to send messages in this AI chat
          </p>
        </div>
      )}
    </div>
  );
};

export default AiChatView;
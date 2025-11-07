import React, { useEffect, useState, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import AiInput from '@/components/ai/AiInput';
import { ChatInputRef } from '@/components/messages/ChatInput';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, Settings, Plus, History, StopCircle, Server } from 'lucide-react';
import { MessageRenderer } from '@/components/ai/MessageRenderer';
import { AgentRole, AgentRoleUtils } from '@/lib/ai/agent-roles';
import { RoleSelector } from '@/components/ai/RoleSelector';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth, patch, del } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { useMCPStore } from '@/stores/useMCPStore';
import { useMCP } from '@/hooks/useMCP';
import { toast } from 'sonner';
import { AiUsageMonitor } from '@/components/ai/AiUsageMonitor';


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
  const pathname = usePathname();
  const { rightSidebarOpen, toggleRightSidebar } = useLayoutStore();

  // Use shared global chat context
  const {
    chatConfig,
    messages: globalMessages,
    setMessages: setGlobalMessages,
    isStreaming: globalIsStreaming,
    setIsStreaming: setGlobalIsStreaming,
    stopStreaming: globalStopStreaming,
    setStopStreaming: setGlobalStopStreaming,
    currentConversationId,
    isInitialized,
    createNewConversation,
    refreshConversation,
  } = useGlobalChat();

  // Local state for component-specific concerns
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [showApiKeyInput, setShowApiKeyInput] = useState<boolean>(false);
  const [input, setInput] = useState<string>('');
  const [currentAgentRole, setCurrentAgentRole] = useState<AgentRole>(AgentRoleUtils.getDefaultRole());
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);

  // MCP state
  const { isChatMCPEnabled, setChatMCPEnabled } = useMCPStore();
  const mcp = useMCP();
  const mcpEnabled = isChatMCPEnabled(currentConversationId || 'global');
  const [mcpToolSchemas, setMcpToolSchemas] = useState<Array<{
    name: string;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
    serverName: string;
  }>>([]);

  // Count running MCP servers
  const runningMCPServers = React.useMemo(() => {
    if (!mcp.isDesktop) return 0;
    return Object.values(mcp.serverStatuses).filter(s => s.status === 'running').length;
  }, [mcp.isDesktop, mcp.serverStatuses]);

  // Refs for auto-scrolling and chat input
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const prevStatusRef = useRef<string>('ready');
  
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

  // URL watching and conversation loading is now handled by GlobalChatContext

  // Create own Chat instance for streaming
  // This component manages the stream and syncs to global state
  const {
    messages: localMessages,
    sendMessage,
    status,
    error,
    regenerate,
    setMessages: setLocalMessages,
    stop,
  } = useChat(chatConfig || {});

  // Sync local messages to global state
  // This ensures both views always render the same messages
  useEffect(() => {
    setGlobalMessages(localMessages);
  }, [localMessages, setGlobalMessages]);

  // Sync streaming status to global state
  // This prevents race conditions when switching views mid-stream
  useEffect(() => {
    const isCurrentlyStreaming = status === 'submitted' || status === 'streaming';
    const wasStreaming = prevStatusRef.current === 'submitted' || prevStatusRef.current === 'streaming';

    // Only update global state if there's an actual transition
    if (isCurrentlyStreaming && !wasStreaming) {
      // We started streaming
      setGlobalIsStreaming(true);
    } else if (!isCurrentlyStreaming && wasStreaming) {
      // We stopped streaming (actual transition, not just mounting as ready)
      setGlobalIsStreaming(false);
    }

    // Update the ref for next comparison
    prevStatusRef.current = status;
  }, [status, setGlobalIsStreaming]);

  // Register local stop function to global context when streaming
  // This allows the other view to stop this view's stream
  useEffect(() => {
    const streaming = status === 'submitted' || status === 'streaming';
    if (streaming) {
      setGlobalStopStreaming(() => stop);
    } else {
      setGlobalStopStreaming(null);
    }
  }, [status, stop, setGlobalStopStreaming]);

  // Message action handlers (defined after useChat so we have access to messages, setMessages, regenerate)
  const handleEdit = async (messageId: string, newContent: string) => {
    if (!currentConversationId) return;

    try {
      // Persist to backend (already handles structured content correctly)
      await patch(`/api/ai_conversations/${currentConversationId}/messages/${messageId}`, {
        content: newContent
      });

      // Refresh conversation (recreates Chat with fresh messages from DB)
      await refreshConversation();

      toast.success('Message updated successfully');
    } catch (error) {
      console.error('Failed to edit message:', error);
      toast.error('Failed to edit message');
      throw error;
    }
  };

  const handleDelete = async (messageId: string) => {
    if (!currentConversationId) return;

    try {
      await del(`/api/ai_conversations/${currentConversationId}/messages/${messageId}`);

      // Optimistically remove from UI (both local and global)
      const filtered = globalMessages.filter(m => m.id !== messageId);
      setGlobalMessages(filtered);
      setLocalMessages(filtered);

      toast.success('Message deleted');
    } catch (error) {
      console.error('Failed to delete message:', error);
      toast.error('Failed to delete message');
      throw error;
    }
  };

  const handleRetry = async () => {
    if (!currentConversationId) return;

    // Before regenerating, clean up old assistant responses after the last user message
    const lastUserMsgIndex = globalMessages.map(m => m.role).lastIndexOf('user');

    if (lastUserMsgIndex !== -1) {
      // Get all assistant messages after the last user message
      const assistantMessagesToDelete = globalMessages
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

      // Remove them from state (both local and global)
      const filteredMessages = globalMessages.filter(
        m => !assistantMessagesToDelete.some(toDelete => toDelete.id === m.id)
      );
      setGlobalMessages(filteredMessages);
      setLocalMessages(filteredMessages);
    }

    // Now regenerate with a clean slate
    regenerate();
  };

  // Determine last assistant message for retry button visibility
  const lastAssistantMessageId = globalMessages
    .filter(m => m.role === 'assistant')
    .slice(-1)[0]?.id;

  const lastUserMessageId = globalMessages
    .filter(m => m.role === 'user')
    .slice(-1)[0]?.id;

  // Register streaming state with editing store (state-based protection)
  // Note: In AI SDK v5, status can be 'ready', 'submitted', 'streaming', or 'error'
  useEffect(() => {
    const componentId = `global-assistant-${currentConversationId || 'init'}`;

    if (status === 'submitted' || status === 'streaming') {
      useEditingStore.getState().startStreaming(componentId, {
        conversationId: currentConversationId || undefined,
        componentName: 'GlobalAssistantView',
      });
    } else {
      useEditingStore.getState().endStreaming(componentId);
    }

    // Cleanup on unmount
    return () => {
      useEditingStore.getState().endStreaming(componentId);
    };
  }, [status, currentConversationId]);

  // ✅ Combined scroll effects - use globalMessages.length instead of messages array
  useEffect(() => {
    scrollToBottom();
  }, [globalMessages.length, status]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Load provider settings on mount
  useEffect(() => {
    const loadProviderSettings = async () => {
      try {
        const configResponse = await fetchWithAuth('/api/ai/chat');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);

        if (!configData.isAnyProviderConfigured) {
          setShowApiKeyInput(true);
        }
      } catch (error) {
        console.error('Failed to load provider settings:', error);
      }
    };

    loadProviderSettings();
  }, []);

  // Fetch MCP tools when MCP is enabled and servers are running
  useEffect(() => {
    const fetchMCPTools = async () => {
      if (mcp.isDesktop && mcpEnabled && runningMCPServers > 0 && window.electron) {
        try {
          console.log('🔧 GlobalAssistantView: Fetching MCP tools from Electron');
          const tools = await window.electron.mcp.getAvailableTools();
          console.log(`✅ GlobalAssistantView: Fetched ${tools.length} MCP tools`, tools.map(t => `${t.serverName}.${t.name}`));
          setMcpToolSchemas(tools);
        } catch (error) {
          console.error('❌ GlobalAssistantView: Failed to fetch MCP tools', error);
          setMcpToolSchemas([]);
          toast.error('Failed to load MCP tools');
        }
      } else {
        // Clear MCP tools when disabled or no servers running
        console.log('🔧 GlobalAssistantView: Clearing MCP tools (disabled or no servers running)');
        setMcpToolSchemas([]);
      }
    };

    fetchMCPTools();
  }, [mcp.isDesktop, mcpEnabled, runningMCPServers]);

  // Use context method to create new conversation
  const handleNewConversation = async () => {
    try {
      await createNewConversation();
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
    if (!input.trim() || !currentConversationId) return;

    // Send the message with location context and MCP tools
    sendMessage(
      { text: input },
      {
        body: {
          agentRole: currentAgentRole,
          locationContext: locationContext || undefined,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
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
      <div className="flex items-center justify-between p-4 border-[var(--separator)]">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium">
            Global Assistant
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {/* MCP Toggle (Desktop only, enabled by default per-conversation) */}
          {mcp.isDesktop && (
            <div className="flex items-center gap-2 border border-[var(--separator)] rounded-lg px-3 py-1.5">
              <Server className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground hidden md:inline">MCP</span>
              {runningMCPServers > 0 && mcpEnabled && (
                <Badge variant="default" className="h-5 text-xs">
                  {runningMCPServers}
                </Badge>
              )}
              <Switch
                checked={mcpEnabled}
                onCheckedChange={(checked) => setChatMCPEnabled(currentConversationId || 'global', checked)}
                disabled={runningMCPServers === 0}
                aria-label="Enable/disable MCP tools for this conversation"
                className="scale-75 md:scale-100"
              />
            </div>
          )}

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
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-[var(--separator)]">
        <RoleSelector
          currentRole={currentAgentRole}
          onRoleChange={setCurrentAgentRole}
          disabled={status === 'streaming'}
          size="sm"
        />

        {/* AI Usage Monitor - Compact mode inline */}
        {currentConversationId && (
          <AiUsageMonitor
            conversationId={currentConversationId}
            compact
          />
        )}
      </div>

      {/* Messages Area */}
      <div className="flex-1 min-h-0 overflow-hidden px-4">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="max-w-4xl mx-auto w-full">
            <div className="space-y-4 pr-1 sm:pr-4">
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
              ) : globalMessages.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-muted-foreground">
                  <p>Welcome to your Global Assistant! Ask me anything about your workspace.</p>
                </div>
              ) : (
                globalMessages.map(message => (
                  <MessageRenderer
                    key={message.id}
                    message={message}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onRetry={handleRetry}
                    isLastAssistantMessage={message.id === lastAssistantMessageId}
                    isLastUserMessage={message.id === lastUserMessageId}
                  />
                ))
              )}
              
              {globalIsStreaming && !isLoading && (
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
            {globalIsStreaming ? (
              <Button
                onClick={() => globalStopStreaming?.()}
                variant="destructive"
                size="icon"
                title="Stop generating"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSendMessage}
                disabled={!input.trim() || !providerSettings?.isAnyProviderConfigured || isLoading}
                size="icon"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default GlobalAssistantView;

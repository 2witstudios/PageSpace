import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import AiInput from '@/components/ai/AiInput';
import { ChatInputRef } from '@/components/messages/ChatInput';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Send, Settings, Plus, History, StopCircle, Server, MessageSquare, Save } from 'lucide-react';
import { MessageRenderer } from '@/components/ai/MessageRenderer';
import { ReadOnlyToggle } from '@/components/ai/ReadOnlyToggle';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth, patch, del } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { useAgentStore } from '@/stores/useAgentStore';
import { useMCPStore } from '@/stores/useMCPStore';
import { useMCP } from '@/hooks/useMCP';
import { toast } from 'sonner';
import { AiUsageMonitor } from '@/components/ai/AiUsageMonitor';
import { AgentSelector } from '@/components/ai/AgentSelector';
import AgentHistoryTab from '@/components/ai/AgentHistoryTab';
import AgentSettingsTab, { AgentSettingsTabRef } from '@/components/ai/AgentSettingsTab';
import useSWR, { mutate } from 'swr';


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

/**
 * MCP Toggle component - used in header and chat tab
 */
interface MCPToggleProps {
  isDesktop: boolean;
  mcpEnabled: boolean;
  runningServers: number;
  onToggle: (enabled: boolean) => void;
}

const MCPToggle: React.FC<MCPToggleProps> = ({ isDesktop, mcpEnabled, runningServers, onToggle }) => {
  if (!isDesktop) return null;

  return (
    <div className="flex items-center gap-2 border border-[var(--separator)] rounded-lg px-3 py-1.5">
      <Server className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground hidden md:inline">MCP</span>
      {runningServers > 0 && mcpEnabled && (
        <Badge variant="default" className="h-5 text-xs">
          {runningServers}
        </Badge>
      )}
      <Switch
        checked={mcpEnabled}
        onCheckedChange={onToggle}
        disabled={runningServers === 0}
        aria-label="Enable/disable MCP tools for this conversation"
        className="scale-75 md:scale-100"
      />
    </div>
  );
};

/**
 * Get user-friendly error message based on error content
 */
const getAIErrorMessage = (errorMessage: string | undefined): string => {
  if (!errorMessage) return 'Something went wrong. Please try again.';

  if (errorMessage.includes('Unauthorized') || errorMessage.includes('401')) {
    return 'Authentication failed. Please refresh the page and try again.';
  }

  if (
    errorMessage.toLowerCase().includes('rate') ||
    errorMessage.toLowerCase().includes('limit') ||
    errorMessage.includes('429') ||
    errorMessage.includes('402') ||
    errorMessage.includes('Failed after') ||
    errorMessage.includes('Provider returned error')
  ) {
    return 'Free tier rate limit hit. Please try again in a few seconds or subscribe for premium models and access.';
  }

  return 'Something went wrong. Please try again.';
};

const GlobalAssistantView: React.FC = () => {
  const pathname = usePathname();
  const { rightSidebarOpen, toggleRightSidebar } = useLayoutStore();

  // Use shared global chat context for Global Assistant mode
  // When an agent is selected, we use LOCAL state instead (like AiChatView)
  const {
    chatConfig: globalChatConfig,
    setMessages: setGlobalMessages,
    setIsStreaming: setGlobalIsStreaming,
    setStopStreaming: setGlobalStopStreaming,
    currentConversationId: globalConversationId,
    isInitialized: globalIsInitialized,
    createNewConversation,
    refreshConversation,
  } = useGlobalChat();

  // Agent selection state from Zustand store (separate from GlobalChatContext)
  // This ensures sidebar never sees agent state - just like AiChatView pattern
  const { selectedAgent, selectAgent, initializeFromUrlOrCookie } = useAgentStore();

  // Local state for component-specific concerns
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [showApiKeyInput, setShowApiKeyInput] = useState<boolean>(false);
  const [input, setInput] = useState<string>('');
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);

  // ============================================
  // AGENT MODE: Local state (like AiChatView)
  // When agent is selected, we DON'T use GlobalChatContext for chat
  // This allows sidebar to use GlobalChatContext independently
  // ============================================
  const [agentConversationId, setAgentConversationId] = useState<string | null>(null);
  const [agentInitialMessages, setAgentInitialMessages] = useState<UIMessage[]>([]);
  const [agentIsInitialized, setAgentIsInitialized] = useState<boolean>(false);
  // Track which agent the current conversation belongs to (prevents stale state on agent switch)
  const [agentIdForConversation, setAgentIdForConversation] = useState<string | null>(null);

  // Agent mode state (tabs, settings)
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [agentConfig, setAgentConfig] = useState<{
    systemPrompt: string;
    enabledTools: string[];
    availableTools: Array<{ name: string; description: string }>;
    aiProvider?: string;
    aiModel?: string;
  } | null>(null);
  const [agentSelectedProvider, setAgentSelectedProvider] = useState<string>('pagespace');
  const [agentSelectedModel, setAgentSelectedModel] = useState<string>('');
  const agentSettingsRef = useRef<AgentSettingsTabRef>(null);

  // Edit version for forcing re-renders after message edits (like AiChatView)
  const [editVersion, setEditVersion] = useState(0);

  // ============================================
  // AGENT STORE: Initialize from URL/cookie on mount
  // This restores agent selection if user refreshes page
  // ============================================
  useEffect(() => {
    initializeFromUrlOrCookie();
  }, [initializeFromUrlOrCookie]);

  // ============================================
  // AGENT MODE: Load/create conversation when agent is selected
  // This is the key effect that sets up agent mode independently
  // ============================================
  useEffect(() => {
    const loadOrCreateAgentConversation = async () => {
      if (!selectedAgent) {
        // Switching back to global mode - reset ALL agent state
        setAgentConversationId(null);
        setAgentInitialMessages([]);
        setAgentIsInitialized(false);
        setAgentIdForConversation(null);
        return;
      }

      // Check if we're switching to a DIFFERENT agent
      const isSwitchingAgents = agentIdForConversation !== null && agentIdForConversation !== selectedAgent.id;

      // If we already have a valid conversation for THIS SAME agent, don't reload
      if (agentConversationId && agentIsInitialized && agentIdForConversation === selectedAgent.id) {
        return;
      }

      // Reset state when switching agents or recreating after deletion
      // This ensures no messages can be sent to the wrong agent during async load
      if (isSwitchingAgents || !agentIdForConversation) {
        setAgentConversationId(null);
      }
      setAgentInitialMessages([]);
      setAgentIsInitialized(false);

      // Check URL for existing conversation ID
      const urlParams = new URLSearchParams(window.location.search);
      const conversationIdFromUrl = urlParams.get('c');
      const agentIdFromUrl = urlParams.get('agent');

      // If URL has conversation for THIS agent, load it
      if (conversationIdFromUrl && agentIdFromUrl === selectedAgent.id) {
        try {
          const response = await fetchWithAuth(
            `/api/agents/${selectedAgent.id}/conversations/${conversationIdFromUrl}/messages`
          );
          if (response.ok) {
            const data = await response.json();
            setAgentConversationId(conversationIdFromUrl);
            setAgentInitialMessages(data.messages || []);
            setAgentIsInitialized(true);
            setAgentIdForConversation(selectedAgent.id);
            return;
          }
        } catch (error) {
          console.error('Failed to load conversation from URL:', error);
          toast.error('Failed to load conversation. Creating new one.');
        }
      }

      // Try to load most recent conversation for this agent
      try {
        const response = await fetchWithAuth(
          `/api/agents/${selectedAgent.id}/conversations?limit=1`
        );
        if (response.ok) {
          const data = await response.json();
          if (data.conversations && data.conversations.length > 0) {
            const mostRecent = data.conversations[0];
            // Load messages for this conversation
            const messagesResponse = await fetchWithAuth(
              `/api/agents/${selectedAgent.id}/conversations/${mostRecent.id}/messages`
            );
            if (messagesResponse.ok) {
              const messagesData = await messagesResponse.json();
              setAgentConversationId(mostRecent.id);
              setAgentInitialMessages(messagesData.messages || []);
              setAgentIsInitialized(true);
              setAgentIdForConversation(selectedAgent.id);

              // Update URL
              const url = new URL(window.location.href);
              url.searchParams.set('c', mostRecent.id);
              url.searchParams.set('agent', selectedAgent.id);
              window.history.replaceState({}, '', url.toString());
              return;
            }
          }
        }
      } catch (error) {
        console.error('Failed to load recent conversation:', error);
      }

      // No existing conversation - create a new one
      try {
        const response = await fetchWithAuth(
          `/api/agents/${selectedAgent.id}/conversations`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );
        if (response.ok) {
          const data = await response.json();
          const newConversationId = data.conversationId || data.id;
          setAgentConversationId(newConversationId);
          setAgentInitialMessages([]);
          setAgentIsInitialized(true);
          setAgentIdForConversation(selectedAgent.id);

          // Update URL
          const url = new URL(window.location.href);
          url.searchParams.set('c', newConversationId);
          url.searchParams.set('agent', selectedAgent.id);
          window.history.replaceState({}, '', url.toString());
        }
      } catch (error) {
        console.error('Failed to create new agent conversation:', error);
        toast.error('Failed to initialize agent conversation');
        setAgentIsInitialized(true); // Allow UI to recover from error state
        setAgentIdForConversation(selectedAgent.id); // Still track the agent to prevent loops
      }
    };

    loadOrCreateAgentConversation();
  }, [selectedAgent, agentConversationId, agentIdForConversation]);

  // MCP state - use appropriate conversation ID based on mode
  const { isChatMCPEnabled, setChatMCPEnabled } = useMCPStore();
  const mcp = useMCP();
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;
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

  // ============================================
  // AGENT MODE: Local chat config (like AiChatView)
  // Creates independent chat instance for agent conversations
  // ============================================
  const agentChatConfig = useMemo(() => {
    if (!selectedAgent || !agentConversationId) return null;
    return {
      id: agentConversationId,
      messages: agentInitialMessages,
      transport: new DefaultChatTransport({
        api: '/api/ai/chat',
        fetch: (url, options) => {
          const urlString = url instanceof Request ? url.url : url.toString();
          return fetchWithAuth(urlString, options);
        },
      }),
      experimental_throttle: 50,
      onError: (error: Error) => {
        console.error('❌ Agent Chat error:', error);
      },
    };
  }, [selectedAgent, agentConversationId, agentInitialMessages]);

  // ============================================
  // GLOBAL MODE: Use shared context chat config
  // ============================================
  // Create Chat instance for GLOBAL mode (syncs with sidebar)
  const {
    messages: globalLocalMessages,
    sendMessage: globalSendMessage,
    status: globalStatus,
    error: globalError,
    regenerate: globalRegenerate,
    setMessages: setGlobalLocalMessages,
    stop: globalStop,
  } = useChat(globalChatConfig || {});

  // Create Chat instance for AGENT mode (independent, like AiChatView)
  const {
    messages: agentMessages,
    sendMessage: agentSendMessage,
    status: agentStatus,
    error: agentError,
    regenerate: agentRegenerate,
    setMessages: setAgentMessages,
    stop: agentStop,
  } = useChat(agentChatConfig || {});

  // ============================================
  // Unified interface - select correct values based on mode
  // ============================================
  const messages = selectedAgent ? agentMessages : globalLocalMessages;
  const sendMessage = selectedAgent ? agentSendMessage : globalSendMessage;
  const status = selectedAgent ? agentStatus : globalStatus;
  const error = selectedAgent ? agentError : globalError;
  const regenerate = selectedAgent ? agentRegenerate : globalRegenerate;
  const stop = selectedAgent ? agentStop : globalStop;

  // Unified streaming state for UI
  const isStreaming = status === 'submitted' || status === 'streaming';

  // Clear useChat messages when switching agents to prevent stale UI
  useEffect(() => {
    if (!selectedAgent) {
      // Switching to global mode - clear agent messages
      setAgentMessages([]);
    } else if (agentIdForConversation !== selectedAgent.id) {
      // Switching to a different agent - clear stale messages immediately
      setAgentMessages([]);
    }
  }, [selectedAgent, agentIdForConversation, setAgentMessages]);

  // Stop global stream when switching to agent mode
  useEffect(() => {
    if (selectedAgent && (globalStatus === 'submitted' || globalStatus === 'streaming')) {
      globalStop();
    }
  }, [selectedAgent, globalStatus, globalStop]);

  // GLOBAL MODE ONLY: Sync local messages to global context
  // This keeps sidebar in sync with this view
  useEffect(() => {
    if (!selectedAgent) {
      setGlobalMessages(globalLocalMessages);
    }
  }, [selectedAgent, globalLocalMessages, setGlobalMessages]);

  // GLOBAL MODE ONLY: Sync streaming status to global context
  useEffect(() => {
    if (selectedAgent) return; // Skip for agent mode

    const isCurrentlyStreaming = globalStatus === 'submitted' || globalStatus === 'streaming';
    const wasStreaming = prevStatusRef.current === 'submitted' || prevStatusRef.current === 'streaming';

    if (isCurrentlyStreaming && !wasStreaming) {
      setGlobalIsStreaming(true);
    } else if (!isCurrentlyStreaming && wasStreaming) {
      setGlobalIsStreaming(false);
    }

    prevStatusRef.current = globalStatus;
  }, [selectedAgent, globalStatus, setGlobalIsStreaming]);

  // GLOBAL MODE ONLY: Register stop function to global context
  useEffect(() => {
    if (selectedAgent) return; // Skip for agent mode

    const streaming = globalStatus === 'submitted' || globalStatus === 'streaming';
    if (streaming) {
      setGlobalStopStreaming(() => globalStop);
    } else {
      setGlobalStopStreaming(null);
    }
  }, [selectedAgent, globalStatus, globalStop, setGlobalStopStreaming]);

  // Message action handlers - work with both global and agent mode
  const handleEdit = async (messageId: string, newContent: string) => {
    if (!currentConversationId) return;

    try {
      if (selectedAgent) {
        // Agent mode: Use agent API
        await patch(`/api/agents/${selectedAgent.id}/conversations/${currentConversationId}/messages/${messageId}`, {
          content: newContent
        });
        // Refetch agent messages
        const response = await fetchWithAuth(
          `/api/agents/${selectedAgent.id}/conversations/${currentConversationId}/messages`
        );
        if (response.ok) {
          const data = await response.json();
          setAgentMessages(data.messages || []);
          setAgentInitialMessages(data.messages || []);
          setEditVersion(v => v + 1); // Force re-render with new key
        }
      } else {
        // Global mode: Use global API and refresh via context
        await patch(`/api/ai_conversations/${currentConversationId}/messages/${messageId}`, {
          content: newContent
        });
        await refreshConversation();
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
    if (!currentConversationId) return;

    try {
      if (selectedAgent) {
        // Agent mode: Use agent API
        await del(`/api/agents/${selectedAgent.id}/conversations/${currentConversationId}/messages/${messageId}`);
        // Optimistically update local state
        const filtered = messages.filter(m => m.id !== messageId);
        setAgentMessages(filtered);
      } else {
        // Global mode: Use global API and sync both states
        await del(`/api/ai_conversations/${currentConversationId}/messages/${messageId}`);
        const filtered = messages.filter(m => m.id !== messageId);
        setGlobalMessages(filtered);
        setGlobalLocalMessages(filtered);
      }

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
    const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');

    if (lastUserMsgIndex !== -1) {
      // Get all assistant messages after the last user message
      const assistantMessagesToDelete = messages
        .slice(lastUserMsgIndex + 1)
        .filter(m => m.role === 'assistant');

      // Delete them from the database
      for (const msg of assistantMessagesToDelete) {
        try {
          if (selectedAgent) {
            await del(`/api/agents/${selectedAgent.id}/conversations/${currentConversationId}/messages/${msg.id}`);
          } else {
            await del(`/api/ai_conversations/${currentConversationId}/messages/${msg.id}`);
          }
        } catch (error) {
          console.error('Failed to delete old assistant message:', error);
        }
      }

      // Remove them from state
      const filteredMessages = messages.filter(
        m => !assistantMessagesToDelete.some(toDelete => toDelete.id === m.id)
      );

      if (selectedAgent) {
        setAgentMessages(filteredMessages);
      } else {
        setGlobalMessages(filteredMessages);
        setGlobalLocalMessages(filteredMessages);
      }
    }

    // Now regenerate with a clean slate (like AiChatView pattern)
    regenerate({
      body: selectedAgent
        ? {
            chatId: selectedAgent.id,
            conversationId: currentConversationId,
          }
        : undefined,
    });
  };

  // Determine last assistant message for retry button visibility
  const lastAssistantMessageId = messages
    .filter(m => m.role === 'assistant')
    .slice(-1)[0]?.id;

  const lastUserMessageId = messages
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

  // SWR for agent conversations (only when agent is selected and History tab is active)
  const agentConversationsKey = selectedAgent && activeTab === 'history'
    ? `/api/agents/${selectedAgent.id}/conversations`
    : null;
  const { data: conversationsData, isLoading: isLoadingConversations } = useSWR(
    agentConversationsKey,
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load conversations');
      return response.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 5000,
    }
  );

  // Transform conversations data with proper date parsing
  const agentConversations = React.useMemo(() => {
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

  // Load agent config when agent is selected
  useEffect(() => {
    const loadAgentConfig = async () => {
      if (!selectedAgent) {
        setAgentConfig(null);
        return;
      }

      try {
        const response = await fetchWithAuth(`/api/pages/${selectedAgent.id}/agent-config`);
        if (response.ok) {
          const config = await response.json();
          setAgentConfig(config);
          if (config.aiProvider) setAgentSelectedProvider(config.aiProvider);
          if (config.aiModel) setAgentSelectedModel(config.aiModel);
        }
      } catch (error) {
        console.error('Failed to load agent config:', error);
      }
    };

    loadAgentConfig();
  }, [selectedAgent]);

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

  // Create new conversation - uses appropriate state based on mode
  const handleNewConversation = async () => {
    try {
      if (selectedAgent) {
        // Create new conversation locally for the selected agent
        const response = await fetchWithAuth(
          `/api/agents/${selectedAgent.id}/conversations`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );
        if (response.ok) {
          const data = await response.json();
          const newConversationId = data.conversationId || data.id;
          setAgentConversationId(newConversationId);
          setAgentInitialMessages([]);
          setAgentMessages([]);

          // Update URL
          const url = new URL(window.location.href);
          url.searchParams.set('c', newConversationId);
          url.searchParams.set('agent', selectedAgent.id);
          window.history.pushState({}, '', url.toString());
        }
      } else {
        // Create new global conversation via context
        await createNewConversation();
      }
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

    // Build request body based on mode
    const requestBody = selectedAgent
      ? {
          // Agent mode: Include agent-specific context (like AiChatView)
          chatId: selectedAgent.id,
          conversationId: currentConversationId,
          selectedProvider: agentSelectedProvider,
          selectedModel: agentSelectedModel,
          isReadOnly,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
        }
      : {
          // Global mode: Include location context
          isReadOnly,
          locationContext: locationContext || undefined,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
        };

    sendMessage(
      { text: input },
      { body: requestBody }
    );
    setInput('');
    chatInputRef.current?.clear();
    setTimeout(scrollToBottom, 100);
  };

  // Agent history management functions - uses LOCAL state (not GlobalChatContext)
  const loadAgentConversationHandler = React.useCallback(async (conversationId: string) => {
    if (!selectedAgent) return;
    try {
      const response = await fetchWithAuth(
        `/api/agents/${selectedAgent.id}/conversations/${conversationId}/messages`
      );
      if (response.ok) {
        const data = await response.json();
        // Update LOCAL agent state (not GlobalChatContext)
        setAgentConversationId(conversationId);
        setAgentInitialMessages(data.messages || []);
        setAgentMessages(data.messages || []);
        setActiveTab('chat'); // Switch to chat tab

        // Update URL
        const url = new URL(window.location.href);
        url.searchParams.set('c', conversationId);
        url.searchParams.set('agent', selectedAgent.id);
        window.history.pushState({}, '', url.toString());

        toast.success('Conversation loaded');
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
      toast.error('Failed to load conversation');
    }
  }, [selectedAgent, setAgentMessages]);

  // Create new agent conversation - uses LOCAL state (not GlobalChatContext)
  const handleAgentNewConversation = React.useCallback(async () => {
    if (!selectedAgent) return;
    try {
      const response = await fetchWithAuth(
        `/api/agents/${selectedAgent.id}/conversations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      if (response.ok) {
        const data = await response.json();
        const newConversationId = data.conversationId || data.id;

        // Update LOCAL agent state
        setAgentConversationId(newConversationId);
        setAgentInitialMessages([]);
        setAgentMessages([]);
        setActiveTab('chat');

        // Update URL
        const url = new URL(window.location.href);
        url.searchParams.set('c', newConversationId);
        url.searchParams.set('agent', selectedAgent.id);
        window.history.pushState({}, '', url.toString());

        // Invalidate SWR cache to reload conversations list
        if (agentConversationsKey) {
          mutate(agentConversationsKey);
        }
        toast.success('New conversation started');
      }
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast.error('Failed to create new conversation');
    }
  }, [selectedAgent, agentConversationsKey, setAgentMessages]);

  // Delete agent conversation - uses LOCAL state (not GlobalChatContext)
  const deleteAgentConversation = React.useCallback(async (conversationId: string) => {
    if (!selectedAgent) return;
    try {
      const response = await fetchWithAuth(
        `/api/agents/${selectedAgent.id}/conversations/${conversationId}`,
        { method: 'DELETE' }
      );
      if (response.ok) {
        // If deleting current conversation, clear LOCAL messages and create new conversation
        if (conversationId === agentConversationId) {
          setAgentConversationId(null);
          setAgentInitialMessages([]);
          setAgentMessages([]);
          // Will trigger the useEffect to create a new conversation
        }
        // Invalidate SWR cache to reload conversations list
        if (agentConversationsKey) {
          mutate(agentConversationsKey);
        }
        toast.success('Conversation deleted');
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      toast.error('Failed to delete conversation');
    }
  }, [selectedAgent, agentConversationId, agentConversationsKey, setAgentMessages]);

  // Agent settings handlers
  const isAgentProviderConfigured = React.useCallback((provider: string): boolean => {
    if (provider === 'pagespace') {
      return providerSettings?.providers.pagespace?.isConfigured || false;
    }
    return providerSettings?.providers[provider as keyof typeof providerSettings.providers]?.isConfigured || false;
  }, [providerSettings]);

  // Show loading skeleton while initializing - derived from mode
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
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
      {/* Header with Agent Selector, conversation info and action buttons */}
      <div className="flex items-center justify-between p-4 border-[var(--separator)]">
        <div className="flex items-center space-x-2">
          <AgentSelector
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            disabled={status === 'streaming'}
          />
        </div>

        <div className="flex items-center space-x-2">
          {/* MCP Toggle (Desktop only, enabled by default per-conversation) */}
          <MCPToggle
            isDesktop={mcp.isDesktop}
            mcpEnabled={mcpEnabled}
            runningServers={runningMCPServers}
            onToggle={(checked) => setChatMCPEnabled(currentConversationId || 'global', checked)}
          />

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

      {/* Agent Mode: Tabbed interface */}
      {selectedAgent ? (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center justify-between px-4 pt-2 border-b border-gray-200 dark:border-[var(--separator)]">
            <TabsList className="h-10">
              <TabsTrigger value="chat" className="gap-2">
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">Chat</span>
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-2">
                <History className="h-4 w-4" />
                <span className="hidden sm:inline">History</span>
              </TabsTrigger>
              <TabsTrigger value="settings" className="gap-2">
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Settings</span>
              </TabsTrigger>
            </TabsList>

            {/* Chat tab actions */}
            {activeTab === 'chat' && (
              <div className="flex items-center gap-3">
                {/* AI Usage Monitor - Compact mode inline */}
                <AiUsageMonitor
                  pageId={selectedAgent.id}
                  compact
                />

                {/* MCP Toggle (Desktop only) */}
                <MCPToggle
                  isDesktop={mcp.isDesktop}
                  mcpEnabled={mcpEnabled}
                  runningServers={runningMCPServers}
                  onToggle={(checked) => setChatMCPEnabled(currentConversationId || 'global', checked)}
                />
              </div>
            )}

            {/* Settings tab actions */}
            {activeTab === 'settings' && (
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => agentSettingsRef.current?.submitForm()}
                  disabled={agentSettingsRef.current?.isSaving}
                >
                  {agentSettingsRef.current?.isSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      Save
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* Chat Tab Content */}
          <TabsContent value="chat" className="flex-1 flex flex-col min-h-0 m-0">
            {/* Read-Only Toggle Header for chat */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-[var(--separator)]">
              <ReadOnlyToggle
                isReadOnly={isReadOnly}
                onToggle={setIsReadOnly}
                disabled={status === 'streaming'}
                size="sm"
              />
            </div>

            {/* Messages Area */}
            <div className="flex-1 min-h-0 overflow-hidden px-4">
              <ScrollArea className="h-full" ref={scrollAreaRef}>
                <div className="max-w-4xl mx-auto w-full">
                  <div className="space-y-4 pr-1 sm:pr-4">
                    {isLoading ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-center h-32 text-muted-foreground">
                          <div className="flex items-center space-x-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>Loading {selectedAgent.title}...</span>
                          </div>
                        </div>
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="flex items-center justify-center h-32 text-muted-foreground">
                        <p>Start a conversation with {selectedAgent.title}</p>
                      </div>
                    ) : (
                      messages.map(message => (
                        <MessageRenderer
                          key={`${message.id}-${editVersion}`}
                          message={message}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onRetry={handleRetry}
                          isLastAssistantMessage={message.id === lastAssistantMessageId}
                          isLastUserMessage={message.id === lastUserMessageId}
                        />
                      ))
                    )}

                    {isStreaming && !isLoading && (
                      <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 mr-8">
                        <div className="text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                          {selectedAgent.title}
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
                      {getAIErrorMessage(error.message)}
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
                    placeholder={isLoading ? "Loading..." : `Ask ${selectedAgent.title}...`}
                    driveId={selectedAgent.driveId}
                    crossDrive={false}
                  />
                  {isStreaming ? (
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
          </TabsContent>

          {/* History Tab Content */}
          <TabsContent value="history" className="flex-1 min-h-0 m-0">
            <AgentHistoryTab
              conversations={agentConversations}
              currentConversationId={currentConversationId}
              onSelectConversation={loadAgentConversationHandler}
              onCreateNew={handleAgentNewConversation}
              onDeleteConversation={deleteAgentConversation}
              isLoading={isLoadingConversations}
            />
          </TabsContent>

          {/* Settings Tab Content */}
          <TabsContent value="settings" className="flex-1 min-h-0 m-0 overflow-y-auto">
            <AgentSettingsTab
              ref={agentSettingsRef}
              pageId={selectedAgent.id}
              config={agentConfig}
              onConfigUpdate={setAgentConfig}
              selectedProvider={agentSelectedProvider}
              selectedModel={agentSelectedModel}
              onProviderChange={setAgentSelectedProvider}
              onModelChange={setAgentSelectedModel}
              isProviderConfigured={isAgentProviderConfigured}
            />
          </TabsContent>
        </Tabs>
      ) : (
        /* Global Assistant Mode: Original flat layout */
        <>
          {/* Read-Only Toggle Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-[var(--separator)]">
            <ReadOnlyToggle
              isReadOnly={isReadOnly}
              onToggle={setIsReadOnly}
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
                  ) : messages.length === 0 ? (
                    <div className="flex items-center justify-center h-32 text-muted-foreground">
                      <p>Welcome to your Global Assistant! Ask me anything about your workspace.</p>
                    </div>
                  ) : (
                    messages.map(message => (
                      <MessageRenderer
                        key={`${message.id}-${editVersion}`}
                        message={message}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onRetry={handleRetry}
                        isLastAssistantMessage={message.id === lastAssistantMessageId}
                        isLastUserMessage={message.id === lastUserMessageId}
                      />
                    ))
                  )}

                  {isStreaming && !isLoading && (
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
                    {getAIErrorMessage(error.message)}
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
                {isStreaming ? (
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
        </>
      )}
    </div>
  );
};

export default GlobalAssistantView;

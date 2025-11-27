/**
 * GlobalAssistantView - Main view for Global Assistant and Agent mode
 *
 * This component operates in two modes:
 * 1. Global Assistant Mode: Workspace-level assistant synced with sidebar
 * 2. Agent Mode: Page-level AI agent with independent conversation management
 *
 * When an agent is selected, this view operates independently (like AiChatView)
 * to prevent interference with the sidebar's Global Assistant state.
 */

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Settings, Plus, History, MessageSquare, Save } from 'lucide-react';
import { ReadOnlyToggle } from '@/components/ai/ReadOnlyToggle';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { useAgentStore } from '@/stores/useAgentStore';
import { toast } from 'sonner';
import { AiUsageMonitor } from '@/components/ai/AiUsageMonitor';
import { AgentSelector } from '@/components/ai/AgentSelector';
import AgentHistoryTab from '@/components/ai/AgentHistoryTab';
import AgentSettingsTab, { AgentSettingsTabRef } from '@/components/ai/AgentSettingsTab';

// Shared hooks and components
import {
  useMCPTools,
  useMessageActions,
  useProviderSettings,
  useConversations,
  LocationContext,
  AgentConfig,
} from '@/lib/ai/shared';
import {
  MCPToggle,
  ChatMessagesArea,
  ChatInputArea,
  ProviderSetupCard,
  ChatMessagesAreaRef,
  ChatInputAreaRef,
} from '@/components/ai/chat';

const GlobalAssistantView: React.FC = () => {
  const pathname = usePathname();
  const { rightSidebarOpen, toggleRightSidebar } = useLayoutStore();

  // ============================================
  // GLOBAL CHAT CONTEXT - for Global Assistant mode
  // ============================================
  const {
    chatConfig: globalChatConfig,
    setMessages: setGlobalMessages,
    setIsStreaming: setGlobalIsStreaming,
    setStopStreaming: setGlobalStopStreaming,
    currentConversationId: globalConversationId,
    isInitialized: globalIsInitialized,
    createNewConversation,
  } = useGlobalChat();

  // ============================================
  // AGENT STORE - for agent selection
  // ============================================
  const { selectedAgent, selectAgent, initializeFromUrlOrCookie } = useAgentStore();

  // ============================================
  // LOCAL STATE
  // ============================================
  const [input, setInput] = useState<string>('');
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);

  // Agent mode state
  const [agentConversationId, setAgentConversationId] = useState<string | null>(null);
  const [agentInitialMessages, setAgentInitialMessages] = useState<UIMessage[]>([]);
  const [agentIsInitialized, setAgentIsInitialized] = useState<boolean>(false);
  const [agentIdForConversation, setAgentIdForConversation] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentSelectedProvider, setAgentSelectedProvider] = useState<string>('pagespace');
  const [agentSelectedModel, setAgentSelectedModel] = useState<string>('');
  const [editVersion, setEditVersion] = useState(0);

  // Refs
  const messagesAreaRef = useRef<ChatMessagesAreaRef>(null);
  const inputAreaRef = useRef<ChatInputAreaRef>(null);
  const agentSettingsRef = useRef<AgentSettingsTabRef>(null);
  const prevStatusRef = useRef<string>('ready');

  // ============================================
  // SHARED HOOKS
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;

  const { isAnyProviderConfigured, needsSetup, isProviderConfigured } =
    useProviderSettings();

  const { isDesktop, mcpEnabled, setMcpEnabled, runningServers, mcpToolSchemas } =
    useMCPTools({ conversationId: currentConversationId });

  // Conversations for agent history tab
  const {
    conversations: agentConversations,
    isLoading: isLoadingConversations,
    loadConversation: loadAgentConversation,
    createConversation: createAgentConversation,
    deleteConversation: deleteAgentConversation,
  } = useConversations({
    agentId: selectedAgent?.id || null,
    currentConversationId: agentConversationId,
    enabled: selectedAgent !== null && activeTab === 'history',
    onConversationLoad: (conversationId, messages) => {
      setAgentConversationId(conversationId);
      setAgentInitialMessages(messages);
      setAgentMessages(messages);
      setActiveTab('chat');
      updateAgentUrl(conversationId);
    },
    onConversationCreate: (conversationId) => {
      setAgentConversationId(conversationId);
      setAgentInitialMessages([]);
      setAgentMessages([]);
      setActiveTab('chat');
      updateAgentUrl(conversationId);
    },
    onConversationDelete: () => {
      setAgentConversationId(null);
      setAgentInitialMessages([]);
      setAgentMessages([]);
    },
  });

  // Get drives from store
  const { drives, fetchDrives } = useDriveStore();

  // ============================================
  // URL HELPERS
  // ============================================
  const updateAgentUrl = useCallback(
    (conversationId: string) => {
      if (!selectedAgent) return;
      const url = new URL(window.location.href);
      url.searchParams.set('c', conversationId);
      url.searchParams.set('agent', selectedAgent.id);
      window.history.pushState({}, '', url.toString());
    },
    [selectedAgent]
  );

  // ============================================
  // INITIALIZATION EFFECTS
  // ============================================

  // Initialize agent store from URL/cookie
  useEffect(() => {
    initializeFromUrlOrCookie();
  }, [initializeFromUrlOrCookie]);

  // Load drives
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // Extract location context from pathname
  useEffect(() => {
    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2 && pathParts[0] === 'dashboard') {
      const driveId = pathParts[1];
      const driveData = drives.find((d) => d.id === driveId);
      setLocationContext({
        currentDrive: driveData
          ? { id: driveData.id, slug: driveData.slug, name: driveData.name }
          : null,
        currentPage: null,
        breadcrumbs: driveData ? [driveData.name] : [],
      });
    } else {
      setLocationContext(null);
    }
  }, [pathname, drives]);

  // Load/create agent conversation when agent is selected
  useEffect(() => {
    const loadOrCreateAgentConversation = async () => {
      if (!selectedAgent) {
        // Switching back to global mode - reset agent state
        setAgentConversationId(null);
        setAgentInitialMessages([]);
        setAgentIsInitialized(false);
        setAgentIdForConversation(null);
        return;
      }

      const isSwitchingAgents =
        agentIdForConversation !== null && agentIdForConversation !== selectedAgent.id;

      // If we already have a valid conversation for this same agent, don't reload
      if (
        agentConversationId &&
        agentIsInitialized &&
        agentIdForConversation === selectedAgent.id
      ) {
        return;
      }

      // Reset state when switching agents
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
            const messagesResponse = await fetchWithAuth(
              `/api/agents/${selectedAgent.id}/conversations/${mostRecent.id}/messages`
            );
            if (messagesResponse.ok) {
              const messagesData = await messagesResponse.json();
              setAgentConversationId(mostRecent.id);
              setAgentInitialMessages(messagesData.messages || []);
              setAgentIsInitialized(true);
              setAgentIdForConversation(selectedAgent.id);
              updateAgentUrl(mostRecent.id);
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
          updateAgentUrl(newConversationId);
        }
      } catch (error) {
        console.error('Failed to create new agent conversation:', error);
        toast.error('Failed to initialize agent conversation');
        setAgentIsInitialized(true);
        setAgentIdForConversation(selectedAgent.id);
      }
    };

    loadOrCreateAgentConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent, agentConversationId, agentIdForConversation, updateAgentUrl]);

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

  // ============================================
  // CHAT CONFIGURATION
  // ============================================

  // Agent mode chat config
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
        console.error('Agent Chat error:', error);
      },
    };
  }, [selectedAgent, agentConversationId, agentInitialMessages]);

  // Global mode chat
  const {
    messages: globalLocalMessages,
    sendMessage: globalSendMessage,
    status: globalStatus,
    error: globalError,
    regenerate: globalRegenerate,
    setMessages: setGlobalLocalMessages,
    stop: globalStop,
  } = useChat(globalChatConfig || {});

  // Agent mode chat
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
  // UNIFIED INTERFACE - select based on mode
  // ============================================
  const messages = selectedAgent ? agentMessages : globalLocalMessages;
  const sendMessage = selectedAgent ? agentSendMessage : globalSendMessage;
  const status = selectedAgent ? agentStatus : globalStatus;
  const error = selectedAgent ? agentError : globalError;
  const regenerate = selectedAgent ? agentRegenerate : globalRegenerate;
  const stop = selectedAgent ? agentStop : globalStop;
  const isStreaming = status === 'submitted' || status === 'streaming';
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  const isLoading = !isInitialized;

  // ============================================
  // MESSAGE ACTIONS (shared hook)
  // ============================================
  const { handleEdit, handleDelete, handleRetry, lastAssistantMessageId, lastUserMessageId } =
    useMessageActions({
      agentId: selectedAgent?.id || null,
      conversationId: currentConversationId,
      messages,
      setMessages: selectedAgent
        ? (msgs) => {
            setAgentMessages(msgs);
            setAgentInitialMessages(msgs);
          }
        : (msgs) => {
            setGlobalMessages(msgs);
            setGlobalLocalMessages(msgs);
          },
      regenerate,
      onEditVersionChange: () => setEditVersion((v) => v + 1),
    });

  // ============================================
  // GLOBAL MODE SYNC EFFECTS
  // ============================================

  // Clear agent messages when switching modes
  useEffect(() => {
    if (!selectedAgent) {
      setAgentMessages([]);
    } else if (agentIdForConversation !== selectedAgent.id) {
      setAgentMessages([]);
    }
  }, [selectedAgent, agentIdForConversation, setAgentMessages]);

  // Stop global stream when switching to agent mode
  useEffect(() => {
    if (selectedAgent && (globalStatus === 'submitted' || globalStatus === 'streaming')) {
      globalStop();
    }
  }, [selectedAgent, globalStatus, globalStop]);

  // Sync local messages to global context (global mode only)
  useEffect(() => {
    if (!selectedAgent) {
      setGlobalMessages(globalLocalMessages);
    }
  }, [selectedAgent, globalLocalMessages, setGlobalMessages]);

  // Sync streaming status to global context (global mode only)
  useEffect(() => {
    if (selectedAgent) return;
    const isCurrentlyStreaming = globalStatus === 'submitted' || globalStatus === 'streaming';
    const wasStreaming =
      prevStatusRef.current === 'submitted' || prevStatusRef.current === 'streaming';
    if (isCurrentlyStreaming && !wasStreaming) {
      setGlobalIsStreaming(true);
    } else if (!isCurrentlyStreaming && wasStreaming) {
      setGlobalIsStreaming(false);
    }
    prevStatusRef.current = globalStatus;
  }, [selectedAgent, globalStatus, setGlobalIsStreaming]);

  // Register stop function to global context (global mode only)
  useEffect(() => {
    if (selectedAgent) return;
    if (globalStatus === 'submitted' || globalStatus === 'streaming') {
      setGlobalStopStreaming(() => globalStop);
    } else {
      setGlobalStopStreaming(null);
    }
  }, [selectedAgent, globalStatus, globalStop, setGlobalStopStreaming]);

  // Register streaming state with editing store
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
    return () => {
      useEditingStore.getState().endStreaming(componentId);
    };
  }, [status, currentConversationId]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // ============================================
  // HANDLERS
  // ============================================

  const handleNewConversation = async () => {
    if (selectedAgent) {
      await createAgentConversation();
    } else {
      await createNewConversation();
    }
  };

  const handleOpenSettings = () => {
    if (!rightSidebarOpen) toggleRightSidebar();
    localStorage.setItem('globalAssistantActiveTab', 'settings');
    window.dispatchEvent(new Event('storage'));
  };

  const handleOpenHistory = () => {
    if (!rightSidebarOpen) toggleRightSidebar();
    localStorage.setItem('globalAssistantActiveTab', 'history');
    window.dispatchEvent(new Event('storage'));
  };

  const handleSendMessage = async () => {
    if (!input.trim() || !currentConversationId) return;

    const requestBody = selectedAgent
      ? {
          chatId: selectedAgent.id,
          conversationId: currentConversationId,
          selectedProvider: agentSelectedProvider,
          selectedModel: agentSelectedModel,
          isReadOnly,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
        }
      : {
          isReadOnly,
          locationContext: locationContext || undefined,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
        };

    sendMessage({ text: input }, { body: requestBody });
    setInput('');
    inputAreaRef.current?.clear();
    setTimeout(() => messagesAreaRef.current?.scrollToBottom(), 100);
  };

  // ============================================
  // RENDER
  // ============================================

  // Show provider setup if needed
  if (needsSetup) {
    return <ProviderSetupCard mode="redirect" onOpenSettings={handleOpenSettings} />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-[var(--separator)]">
        <div className="flex items-center space-x-2">
          <AgentSelector
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            disabled={isStreaming}
          />
        </div>
        <div className="flex items-center space-x-2">
          <MCPToggle
            isDesktop={isDesktop}
            mcpEnabled={mcpEnabled}
            runningServers={runningServers}
            onToggle={setMcpEnabled}
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
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-[var(--separator)]">
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

            {activeTab === 'chat' && (
              <div className="flex items-center gap-3">
                <ReadOnlyToggle
                  isReadOnly={isReadOnly}
                  onToggle={setIsReadOnly}
                  disabled={isStreaming}
                  size="sm"
                />
                <AiUsageMonitor pageId={selectedAgent.id} compact />
              </div>
            )}

            {activeTab === 'settings' && (
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
            )}
          </div>

          {/* Chat Tab */}
          <TabsContent value="chat" className="flex-1 flex flex-col min-h-0 m-0">
            <ChatMessagesArea
              ref={messagesAreaRef}
              messages={messages}
              isLoading={isLoading}
              isStreaming={isStreaming}
              assistantName={selectedAgent.title}
              emptyMessage={`Start a conversation with ${selectedAgent.title}`}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onRetry={handleRetry}
              lastAssistantMessageId={lastAssistantMessageId}
              lastUserMessageId={lastUserMessageId}
              editVersion={editVersion}
              useConversationRenderer={true}
            />
            <ChatInputArea
              ref={inputAreaRef}
              value={input}
              onChange={setInput}
              onSend={handleSendMessage}
              onStop={stop}
              isStreaming={isStreaming}
              disabled={!isAnyProviderConfigured}
              isLoading={isLoading}
              placeholder={`Ask ${selectedAgent.title}...`}
              driveId={selectedAgent.driveId}
              crossDrive={false}
              error={error}
              showError={showError}
              onClearError={() => setShowError(false)}
            />
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history" className="flex-1 min-h-0 m-0">
            <AgentHistoryTab
              conversations={agentConversations}
              currentConversationId={currentConversationId}
              onSelectConversation={loadAgentConversation}
              onCreateNew={createAgentConversation}
              onDeleteConversation={deleteAgentConversation}
              isLoading={isLoadingConversations}
            />
          </TabsContent>

          {/* Settings Tab */}
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
              isProviderConfigured={isProviderConfigured}
            />
          </TabsContent>
        </Tabs>
      ) : (
        /* Global Assistant Mode */
        <>
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-[var(--separator)]">
            <ReadOnlyToggle
              isReadOnly={isReadOnly}
              onToggle={setIsReadOnly}
              disabled={isStreaming}
              size="sm"
            />
            {currentConversationId && (
              <AiUsageMonitor conversationId={currentConversationId} compact />
            )}
          </div>

          <ChatMessagesArea
            ref={messagesAreaRef}
            messages={messages}
            isLoading={isLoading}
            isStreaming={isStreaming}
            assistantName="Global Assistant"
            emptyMessage="Welcome to your Global Assistant! Ask me anything about your workspace."
            onEdit={handleEdit}
            onDelete={handleDelete}
            onRetry={handleRetry}
            lastAssistantMessageId={lastAssistantMessageId}
            lastUserMessageId={lastUserMessageId}
            editVersion={editVersion}
            useConversationRenderer={true}
          />

          <ChatInputArea
            ref={inputAreaRef}
            value={input}
            onChange={setInput}
            onSend={handleSendMessage}
            onStop={stop}
            isStreaming={isStreaming}
            disabled={!isAnyProviderConfigured}
            isLoading={isLoading}
            placeholder="Ask about your workspace..."
            driveId={locationContext?.currentDrive?.id}
            crossDrive={true}
            error={error}
            showError={showError}
            onClearError={() => setShowError(false)}
          />
        </>
      )}
    </div>
  );
};

export default GlobalAssistantView;

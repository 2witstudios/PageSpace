/**
 * GlobalAssistantView - Main view for Global Assistant and Agent mode
 *
 * This component operates in two modes:
 * 1. Global Assistant Mode: Workspace-level assistant synced with sidebar
 * 2. Agent Mode: Page-level AI agent using centralized usePageAgentDashboardStore
 *
 * IMPORTANT: This view never has tabs. The right sidebar provides History and
 * Settings tabs that control this view via the shared usePageAgentDashboardStore.
 *
 * STATE MANAGEMENT ARCHITECTURE (3 Systems - Intentional Design):
 *
 * 1. GlobalChatContext (React Context)
 *    - Manages Global Assistant conversations ONLY
 *    - Used when selectedAgent is null
 *    - Persists conversation ID to cookies
 *
 * 2. usePageAgentDashboardStore (Zustand)
 *    - Dashboard/drive context ONLY
 *    - Synced with this middle panel AND the right sidebar
 *    - Agent selection, conversations, sidebar tab state (activeTab)
 *    - Persists agent ID to cookies/URL
 *
 * 3. usePageAgentSidebarState (Zustand + localStorage)
 *    - Page context ONLY (when viewing a specific page)
 *    - Independent from page content - sidebar is standalone
 *    - Has its own agent selection and conversation state
 *    - Persists agent selection to localStorage
 *
 * WHY TWO AGENT STORES (usePageAgentDashboardStore vs usePageAgentSidebarState):
 * The sidebar is designed as an independent chat interface. When viewing
 * a page, users can chat with Agent A in the sidebar while viewing Page B.
 * This independence is intentional UX - only on /dashboard and /drive routes
 * do we sync the sidebar with this middle panel via usePageAgentDashboardStore.
 *
 * TAB COMMUNICATION (replacing localStorage event bus):
 * Instead of using localStorage.setItem() + window.dispatchEvent() for cross-
 * component tab switching, we use usePageAgentDashboardStore.setActiveTab(). The right
 * sidebar subscribes to activeTab in dashboard context, ensuring reactive updates.
 */

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Settings, Plus, History } from 'lucide-react';
import { ReadOnlyToggle } from '@/components/ai/shared/ReadOnlyToggle';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { usePageAgentDashboardStore } from '@/stores/page-agents/usePageAgentDashboardStore';
import { AiUsageMonitor } from '@/components/ai/shared/AiUsageMonitor';
import { AISelector } from '@/components/ai/shared/AISelector';

// Shared hooks and components
import {
  useMCPTools,
  useMessageActions,
  useProviderSettings,
  LocationContext,
} from '@/lib/ai/shared';
import {
  MCPToggle,
  ChatMessagesArea,
  ChatInputArea,
  ProviderSetupCard,
  ChatMessagesAreaRef,
  ChatInputAreaRef,
} from '@/components/ai/shared/chat';

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
  // AGENT STORE - for agent selection and conversation management
  // ============================================
  const {
    selectedAgent,
    selectAgent,
    initializeFromUrlOrCookie,
    conversationId: agentConversationId,
    conversationMessages: agentInitialMessages,
    isConversationLoading: agentIsLoading,
    setConversationMessages: setAgentStoreMessages,
    createNewConversation: createAgentConversation,
    loadMostRecentConversation,
  } = usePageAgentDashboardStore();

  // ============================================
  // LOCAL STATE
  // ============================================
  const [input, setInput] = useState<string>('');
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);

  // Agent mode state (provider/model settings)
  const [agentSelectedProvider, setAgentSelectedProvider] = useState<string>('pagespace');
  const [agentSelectedModel, setAgentSelectedModel] = useState<string>('');
  const [editVersion, setEditVersion] = useState(0);

  // Refs
  const messagesAreaRef = useRef<ChatMessagesAreaRef>(null);
  const inputAreaRef = useRef<ChatInputAreaRef>(null);
  const prevStatusRef = useRef<string>('ready');

  // ============================================
  // SHARED HOOKS
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;

  const { isLoading: isLoadingProviders, isAnyProviderConfigured, needsSetup } =
    useProviderSettings();

  const { isDesktop, mcpEnabled, setMcpEnabled, runningServers, mcpToolSchemas } =
    useMCPTools({ conversationId: currentConversationId });

  // Get drives from store
  const { drives, fetchDrives } = useDriveStore();

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

  // Load most recent conversation when agent is selected
  useEffect(() => {
    if (selectedAgent && !agentConversationId && !agentIsLoading) {
      loadMostRecentConversation();
    }
  }, [selectedAgent, agentConversationId, agentIsLoading, loadMostRecentConversation]);

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

  // Load agent config when agent is selected
  useEffect(() => {
    const loadAgentConfig = async () => {
      if (!selectedAgent) {
        return;
      }
      try {
        const response = await fetchWithAuth(`/api/pages/${selectedAgent.id}/agent-config`);
        if (response.ok) {
          const config = await response.json();
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
  // Agent mode: initialized when we have a conversationId and not loading
  // Global mode: use globalIsInitialized from context
  const agentIsInitialized = selectedAgent ? (!!agentConversationId && !agentIsLoading) : false;
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
            setAgentStoreMessages(msgs); // Sync to store
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

  // Clear agent messages when switching to global mode
  useEffect(() => {
    if (!selectedAgent) {
      setAgentMessages([]);
    }
  }, [selectedAgent, setAgentMessages]);

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

  // Get setActiveTab from store for sidebar tab control
  const { setActiveTab } = usePageAgentDashboardStore();

  const handleNewConversation = async () => {
    if (selectedAgent) {
      await createAgentConversation();
    } else {
      await createNewConversation();
    }
  };

  const handleOpenSettings = () => {
    if (!rightSidebarOpen) toggleRightSidebar();
    setActiveTab('settings');
  };

  const handleOpenHistory = () => {
    if (!rightSidebarOpen) toggleRightSidebar();
    setActiveTab('history');
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

  // Show loading state while checking provider configuration
  if (isLoadingProviders) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Show provider setup if needed
  if (needsSetup) {
    return <ProviderSetupCard mode="redirect" onOpenSettings={handleOpenSettings} />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-[var(--separator)]">
        <div className="flex items-center space-x-2">
          <AISelector
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

      {/* Chat Controls - unified for both modes */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-[var(--separator)]">
        <ReadOnlyToggle
          isReadOnly={isReadOnly}
          onToggle={setIsReadOnly}
          disabled={isStreaming}
          size="sm"
        />
        {selectedAgent ? (
          <AiUsageMonitor pageId={selectedAgent.id} compact />
        ) : (
          currentConversationId && (
            <AiUsageMonitor conversationId={currentConversationId} compact />
          )
        )}
      </div>

      {/* Chat Interface - unified for both modes */}
      <ChatMessagesArea
        ref={messagesAreaRef}
        messages={messages}
        isLoading={isLoading}
        isStreaming={isStreaming}
        assistantName={selectedAgent ? selectedAgent.title : 'Global Assistant'}
        emptyMessage={
          selectedAgent
            ? `Start a conversation with ${selectedAgent.title}`
            : 'Welcome to your Global Assistant! Ask me anything about your workspace.'
        }
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRetry={handleRetry}
        lastAssistantMessageId={lastAssistantMessageId}
        lastUserMessageId={lastUserMessageId}
        editVersion={editVersion}
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
        placeholder={selectedAgent ? `Ask ${selectedAgent.title}...` : 'Ask about your workspace...'}
        driveId={selectedAgent ? selectedAgent.driveId : locationContext?.currentDrive?.id}
        crossDrive={!selectedAgent}
        error={error}
        showError={showError}
        onClearError={() => setShowError(false)}
      />
    </div>
  );
};

export default GlobalAssistantView;

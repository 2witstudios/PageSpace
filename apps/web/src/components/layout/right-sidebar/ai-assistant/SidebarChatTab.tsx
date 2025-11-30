import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { DefaultChatTransport } from 'ai';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import ChatInput, { ChatInputRef } from '@/components/messages/ChatInput';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, Plus, StopCircle } from 'lucide-react';
import { CompactMessageRenderer } from '@/components/ai/shared/CompactMessageRenderer';
import { ReadOnlyToggle } from '@/components/ai/shared/ReadOnlyToggle';
import { AISelector } from '@/components/ai/shared/AISelector';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth, patch, del } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useGlobalChat } from '@/contexts/GlobalChatContext';
import { usePageAgentSidebarState, SidebarAgentInfo } from '@/hooks/page-agents/usePageAgentSidebarState';
import { usePageAgentSidebarChat } from '@/hooks/page-agents/usePageAgentSidebarChat';
import { toast } from 'sonner';
import { AiUsageMonitor } from '@/components/ai/shared/AiUsageMonitor';

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

/**
 * Assistant chat tab for the right sidebar.
 *
 * Supports dual-mode operation:
 * - Global Mode (default): Uses GlobalChatContext, syncs with middle panel
 * - Agent Mode: Uses local state, independent from middle panel
 *
 * The sidebar maintains its own agent selection, separate from the middle panel's usePageAgentDashboardStore.
 */
const SidebarChatTab: React.FC = () => {
  const pathname = usePathname();

  // ============================================
  // Global Chat Context (for global mode sync)
  // ============================================
  const {
    chatConfig: globalChatConfig,
    setMessages: setGlobalContextMessages,
    setIsStreaming: setGlobalIsStreaming,
    setStopStreaming: setGlobalStopStreaming,
    currentConversationId: globalConversationId,
    isInitialized: globalIsInitialized,
    createNewConversation: createGlobalConversation,
    refreshConversation: refreshGlobalConversation,
  } = useGlobalChat();

  // ============================================
  // Sidebar Agent State (custom hook)
  // ============================================
  const {
    selectedAgent,
    conversationId: agentConversationId,
    initialMessages: agentInitialMessages,
    isInitialized: agentIsInitialized,
    selectAgent,
    createNewConversation: createAgentConversation,
    refreshConversation: refreshAgentConversation,
  } = usePageAgentSidebarState();

  // ============================================
  // Agent Chat Configuration
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
        console.error('Sidebar Agent Chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    };
  }, [selectedAgent, agentConversationId, agentInitialMessages]);

  // ============================================
  // Sidebar Chat (custom hook - unified interface)
  // ============================================
  const {
    messages,
    sendMessage,
    status,
    error,
    regenerate,
    setMessages,
    stop,
    isStreaming,
    globalStatus,
    globalStop,
    globalMessages,
    setGlobalMessages,
  } = usePageAgentSidebarChat({
    selectedAgent,
    globalChatConfig,
    agentChatConfig,
  });

  // ============================================
  // Derived State
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  const assistantName = selectedAgent ? selectedAgent.title : 'Global Assistant';

  // ============================================
  // Local Component State
  // ============================================
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [input, setInput] = useState<string>('');
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);
  const [showPageTree, setShowPageTree] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pagespace:assistant:showPageTree') === 'true';
  });

  // Refs
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const prevGlobalStatusRef = useRef<string>('ready');

  // ============================================
  // Helper Functions
  // ============================================
  const scrollToBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, []);

  // Determine if send button should be enabled
  const canSend = useMemo(() => {
    if (!input.trim()) return false;
    if (!currentConversationId) return false;
    if (selectedAgent) return true; // Agent mode has its own provider config
    return providerSettings?.isAnyProviderConfigured ?? false;
  }, [input, currentConversationId, selectedAgent, providerSettings]);

  // ============================================
  // Effects: Drive Loading
  // ============================================
  const { fetchDrives } = useDriveStore();

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // ============================================
  // Effects: Location Context Extraction
  // ============================================
  useEffect(() => {
    const extractLocationContext = async () => {
      const pathParts = pathname.split('/').filter(Boolean);

      if (pathParts.length >= 2 && pathParts[0] === 'dashboard') {
        const driveId = pathParts[1];

        try {
          let currentPage = null;
          let currentDrive = null;

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
          }

          if (pathParts.length > 2) {
            const pageId = pathParts[2];

            try {
              const pageResponse = await fetchWithAuth(`/api/pages/${pageId}`);
              if (pageResponse.ok) {
                const pageData = await pageResponse.json();

                try {
                  const breadcrumbsResponse = await fetchWithAuth(`/api/pages/${pageId}/breadcrumbs`);
                  if (breadcrumbsResponse.ok) {
                    const breadcrumbsData = await breadcrumbsResponse.json();
                    const pathSegments = breadcrumbsData.map((crumb: { title: string }) => crumb.title);
                    const fullPath = `/${currentDrive?.slug}/${pathSegments.join('/')}`;

                    currentPage = {
                      id: pageData.id,
                      title: pageData.title,
                      type: pageData.type,
                      path: fullPath
                    };
                  } else {
                    currentPage = {
                      id: pageData.id,
                      title: pageData.title,
                      type: pageData.type,
                      path: `/${currentDrive?.slug}/${pageData.title}`
                    };
                  }
                } catch {
                  currentPage = {
                    id: pageData.id,
                    title: pageData.title,
                    type: pageData.type,
                    path: `/${currentDrive?.slug}/${pageData.title}`
                  };
                }
              } else {
                currentPage = {
                  id: pageId,
                  title: pathParts[pathParts.length - 1].replace(/-/g, ' '),
                  type: 'DOCUMENT',
                  path: `/${currentDrive?.slug}/${pathParts[pathParts.length - 1].replace(/-/g, ' ')}`
                };
              }
            } catch {
              currentPage = {
                id: pageId,
                title: pathParts[pathParts.length - 1].replace(/-/g, ' '),
                type: 'DOCUMENT',
                path: `/${currentDrive?.slug}/${pathParts[pathParts.length - 1].replace(/-/g, ' ')}`
              };
            }
          }

          const breadcrumbs = [];
          if (currentDrive) {
            breadcrumbs.push(currentDrive.name);
          }
          if (currentPage && currentPage.path) {
            const pathParts = currentPage.path.split('/').filter(Boolean);
            breadcrumbs.push(...pathParts.slice(1));
          }

          setLocationContext({ currentPage, currentDrive, breadcrumbs });
        } catch {
          setLocationContext(null);
        }
      } else {
        setLocationContext(null);
      }
    };

    extractLocationContext();
  }, [pathname]);

  // ============================================
  // Effects: Global Mode Sync to Context
  // ============================================
  useEffect(() => {
    if (!selectedAgent) {
      setGlobalContextMessages(globalMessages);
    }
  }, [selectedAgent, globalMessages, setGlobalContextMessages]);

  useEffect(() => {
    if (selectedAgent) return;

    const isCurrentlyStreaming = globalStatus === 'submitted' || globalStatus === 'streaming';
    const wasStreaming = prevGlobalStatusRef.current === 'submitted' || prevGlobalStatusRef.current === 'streaming';

    if (isCurrentlyStreaming && !wasStreaming) {
      setGlobalIsStreaming(true);
    } else if (!isCurrentlyStreaming && wasStreaming) {
      setGlobalIsStreaming(false);
    }

    prevGlobalStatusRef.current = globalStatus;
  }, [selectedAgent, globalStatus, setGlobalIsStreaming]);

  useEffect(() => {
    if (selectedAgent) return;

    const streaming = globalStatus === 'submitted' || globalStatus === 'streaming';
    if (streaming) {
      setGlobalStopStreaming(() => globalStop);
    } else {
      setGlobalStopStreaming(null);
    }
  }, [selectedAgent, globalStatus, globalStop, setGlobalStopStreaming]);

  // ============================================
  // Effects: Editing Store Registration
  // ============================================
  useEffect(() => {
    const componentId = `assistant-sidebar-${currentConversationId || 'init'}`;

    if (status === 'submitted' || status === 'streaming') {
      useEditingStore.getState().startStreaming(componentId, {
        conversationId: currentConversationId || undefined,
        componentName: 'SidebarChatTab',
      });
    } else {
      useEditingStore.getState().endStreaming(componentId);
    }

    return () => {
      useEditingStore.getState().endStreaming(componentId);
    };
  }, [status, currentConversationId]);

  // ============================================
  // Effects: UI State
  // ============================================
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, status, scrollToBottom]);

  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // ============================================
  // Effects: Provider Settings
  // ============================================
  useEffect(() => {
    const loadProviderSettings = async () => {
      try {
        const configResponse = await fetchWithAuth('/api/ai/settings');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);
      } catch {
        // Silently fail - provider settings are optional in agent mode
      }
    };

    loadProviderSettings();
  }, []);

  useEffect(() => {
    const handleSettingsUpdate = async () => {
      try {
        const configResponse = await fetchWithAuth('/api/ai/settings');
        const configData: ProviderSettings = await configResponse.json();
        setProviderSettings(configData);
      } catch {
        // Silently fail
      }
    };

    window.addEventListener('ai-settings-updated', handleSettingsUpdate);

    // Listen for assistant settings updates (page tree toggle)
    const handleAssistantSettingsUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ showPageTree?: boolean }>;
      if (customEvent.detail?.showPageTree !== undefined) {
        setShowPageTree(customEvent.detail.showPageTree);
      }
    };
    window.addEventListener('assistant-settings-updated', handleAssistantSettingsUpdate);

    return () => {
      window.removeEventListener('ai-settings-updated', handleSettingsUpdate);
      window.removeEventListener('assistant-settings-updated', handleAssistantSettingsUpdate);
    };
  }, []);

  // ============================================
  // Handlers
  // ============================================
  const handleNewConversation = useCallback(async () => {
    try {
      if (selectedAgent) {
        await createAgentConversation();
        setMessages([]);
      } else {
        await createGlobalConversation();
      }
    } catch {
      toast.error('Failed to create new conversation');
    }
  }, [selectedAgent, createAgentConversation, createGlobalConversation, setMessages]);

  const handleSendMessage = useCallback(async () => {
    if (!input.trim() || !currentConversationId) return;

    const body = selectedAgent
      ? {
          chatId: selectedAgent.id,
          conversationId: agentConversationId,
          isReadOnly,
          provider: selectedAgent.aiProvider,
          model: selectedAgent.aiModel,
          systemPrompt: selectedAgent.systemPrompt,
          locationContext: locationContext || undefined,
          enabledTools: selectedAgent.enabledTools,
        }
      : {
          isReadOnly,
          showPageTree,
          locationContext: locationContext || undefined,
          selectedProvider: providerSettings?.currentProvider,
          selectedModel: providerSettings?.currentModel,
        };

    sendMessage({ text: input }, { body });
    setInput('');
    chatInputRef.current?.clear();
    setTimeout(scrollToBottom, 100);
  }, [
    input,
    currentConversationId,
    selectedAgent,
    agentConversationId,
    isReadOnly,
    showPageTree,
    locationContext,
    providerSettings,
    sendMessage,
    scrollToBottom,
  ]);

  const handleEdit = useCallback(async (messageId: string, newContent: string) => {
    if (!currentConversationId) return;

    try {
      if (selectedAgent) {
        await patch(`/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages/${messageId}`, {
          content: newContent,
        });
        await refreshAgentConversation();
      } else {
        await patch(`/api/ai/global/${currentConversationId}/messages/${messageId}`, {
          content: newContent,
        });
        await refreshGlobalConversation();
      }
      toast.success('Message updated successfully');
    } catch {
      toast.error('Failed to update message');
    }
  }, [currentConversationId, selectedAgent, refreshAgentConversation, refreshGlobalConversation]);

  const handleDelete = useCallback(async (messageId: string) => {
    if (!currentConversationId) return;

    try {
      if (selectedAgent) {
        await del(`/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages/${messageId}`);
      } else {
        await del(`/api/ai/global/${currentConversationId}/messages/${messageId}`);
      }

      const filtered = messages.filter(m => m.id !== messageId);
      setMessages(filtered);

      if (!selectedAgent) {
        setGlobalMessages(filtered);
      }

      toast.success('Message deleted');
    } catch {
      toast.error('Failed to delete message');
    }
  }, [currentConversationId, selectedAgent, messages, setMessages, setGlobalMessages]);

  const handleRetry = useCallback(async () => {
    if (!currentConversationId) return;

    const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');

    if (lastUserMsgIndex !== -1) {
      const assistantMessagesToDelete = messages
        .slice(lastUserMsgIndex + 1)
        .filter(m => m.role === 'assistant');

      for (const msg of assistantMessagesToDelete) {
        try {
          if (selectedAgent) {
            await del(`/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages/${msg.id}`);
          } else {
            await del(`/api/ai/global/${currentConversationId}/messages/${msg.id}`);
          }
        } catch {
          // Continue with other deletions
        }
      }

      const filteredMessages = messages.filter(
        m => !assistantMessagesToDelete.some(toDelete => toDelete.id === m.id)
      );
      setMessages(filteredMessages);

      if (!selectedAgent) {
        setGlobalMessages(filteredMessages);
      }
    }

    regenerate();
  }, [currentConversationId, selectedAgent, messages, setMessages, setGlobalMessages, regenerate]);

  // Adapter for AgentSelector (converts SidebarAgentInfo to AgentInfo shape)
  const handleSelectAgent = useCallback((agent: SidebarAgentInfo | null) => {
    selectAgent(agent);
  }, [selectAgent]);

  // ============================================
  // Computed Values for Rendering
  // ============================================
  const lastAssistantMessageId = messages
    .filter(m => m.role === 'assistant')
    .slice(-1)[0]?.id;

  const lastUserMessageId = messages
    .filter(m => m.role === 'user')
    .slice(-1)[0]?.id;

  // ============================================
  // Render
  // ============================================
  if (!isInitialized) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex-grow flex items-center justify-center">
          <div className="flex items-center space-x-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading {assistantName}...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col border-b border-gray-200 dark:border-[var(--separator)] bg-card">
        <div className="flex items-center justify-between p-2">
          <AISelector
            selectedAgent={selectedAgent}
            onSelectAgent={handleSelectAgent}
            disabled={isStreaming}
            className="text-sm font-medium"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNewConversation}
            className="h-7 px-2"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {(currentConversationId || selectedAgent) && (
          <div className="px-2 pb-2">
            <AiUsageMonitor
              conversationId={selectedAgent ? undefined : currentConversationId}
              pageId={selectedAgent ? selectedAgent.id : undefined}
              compact
            />
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-hidden max-w-full" style={{ contain: 'layout' }}>
        <ScrollArea className="h-full p-3 max-w-full" ref={scrollAreaRef}>
          <div className="space-y-3 max-w-full">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-muted-foreground text-xs text-center">
                <div>
                  <p className="font-medium">{assistantName}</p>
                  <p className="text-xs">
                    {locationContext
                      ? `Context-aware help for ${locationContext.currentPage?.title || locationContext.currentDrive?.name}`
                      : 'Ask me anything about your workspace'}
                  </p>
                </div>
              </div>
            ) : (
              messages.map(message => (
                <CompactMessageRenderer
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

            {isStreaming && (
              <div className="p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <div className="text-xs font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {assistantName}
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

      {/* Input */}
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

        <div className="px-1">
          <ReadOnlyToggle
            isReadOnly={isReadOnly}
            onToggle={setIsReadOnly}
            disabled={status === 'streaming'}
            size="sm"
          />
        </div>

        <div className="flex items-center space-x-2">
          <ChatInput
            ref={chatInputRef}
            value={input}
            onChange={setInput}
            onSendMessage={handleSendMessage}
            placeholder={locationContext
              ? `Ask about ${locationContext.currentPage?.title || 'this page'}...`
              : 'Ask about your workspace...'}
            driveId={locationContext?.currentDrive?.id}
            crossDrive={true}
          />
          {isStreaming ? (
            <Button
              onClick={() => stop()}
              variant="destructive"
              size="sm"
              className="h-8 px-3"
              title="Stop generating"
            >
              <StopCircle className="h-3 w-3" />
            </Button>
          ) : (
            <Button
              onClick={handleSendMessage}
              disabled={!canSend}
              size="sm"
              className="h-8 px-3"
            >
              <Send className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SidebarChatTab;

/**
 * AiChatView - Page-level AI agent chat view
 *
 * This component provides a chat interface for AI_CHAT page types.
 * It uses the Agent engine for conversation management, independent
 * from the Global Assistant.
 */

import { TreePage, usePageTree } from '@/hooks/usePageTree';
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Settings, MessageSquare, History, Plus, Save } from 'lucide-react';
import { UIMessage, DefaultChatTransport } from 'ai';
import { useEditingStore } from '@/stores/useEditingStore';
import { buildPagePath } from '@/lib/tree/tree-utils';
import { useDriveStore } from '@/hooks/useDrive';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import PageAgentSettingsTab, { PageAgentSettingsTabRef } from '@/components/ai/page-agents/PageAgentSettingsTab';
import PageAgentHistoryTab from '@/components/ai/page-agents/PageAgentHistoryTab';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

// Shared hooks and components
import {
  useMCPTools,
  useMessageActions,
  useProviderSettings,
  useConversations,
  AgentConfig,
} from '@/lib/ai/shared';
import {
  MCPToggle,
  ChatMessagesArea,
  ChatInputArea,
  ProviderSetupCard,
  ChatMessagesAreaRef,
  ChatInputAreaRef,
} from '@/components/ai/shared/chat';
import { AiUsageMonitor } from '@/components/ai/shared/AiUsageMonitor';

interface AiChatViewProps {
  page: TreePage;
}

const AiChatView: React.FC<AiChatViewProps> = ({ page }) => {
  const params = useParams();
  const driveId = params.driveId as string;
  const { drives } = useDriveStore();
  const { tree } = usePageTree(driveId);
  const { user } = useAuth();

  // ============================================
  // LOCAL STATE
  // ============================================
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [showError, setShowError] = useState(true);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState(0);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);

  // Refs
  const messagesAreaRef = useRef<ChatMessagesAreaRef>(null);
  const inputAreaRef = useRef<ChatInputAreaRef>(null);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);

  // ============================================
  // SHARED HOOKS
  // ============================================
  const {
    isLoading: isLoadingProviders,
    isAnyProviderConfigured,
    needsSetup,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings({ pageId: page.id });

  const { isDesktop, mcpEnabled, setMcpEnabled, runningServers, mcpToolSchemas } =
    useMCPTools({ conversationId: currentConversationId });

  const {
    conversations,
    isLoading: isLoadingConversations,
    loadConversation,
    createConversation,
    deleteConversation,
  } = useConversations({
    agentId: page.id,
    currentConversationId,
    enabled: activeTab === 'history',
    onConversationLoad: (conversationId, messages) => {
      setCurrentConversationId(conversationId);
      setMessages(messages);
      setActiveTab('chat');
    },
    onConversationCreate: (conversationId) => {
      setCurrentConversationId(conversationId);
      setMessages([]);
      setActiveTab('chat');
    },
    onConversationDelete: () => {
      setCurrentConversationId(null);
      setMessages([]);
    },
  });

  // ============================================
  // CHAT CONFIGURATION
  // ============================================
  const chatConfig = useMemo(
    () => ({
      id: page.id,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: '/api/ai/chat',
        fetch: (url, options) => {
          const urlString = url instanceof Request ? url.url : url.toString();
          return fetchWithAuth(urlString, options);
        },
      }),
      experimental_throttle: 50,
      onError: (error: Error) => {
        console.error('AiChatView: Chat error:', error);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.id]
  );

  const { messages, sendMessage, status, error, regenerate, setMessages, stop } =
    useChat(chatConfig);

  const isStreaming = status === 'submitted' || status === 'streaming';
  const isLoading = !isInitialized;

  // ============================================
  // MESSAGE ACTIONS (shared hook)
  // ============================================
  const { handleEdit, handleDelete, handleRetry, lastAssistantMessageId, lastUserMessageId } =
    useMessageActions({
      agentId: page.id,
      conversationId: currentConversationId,
      messages,
      setMessages,
      regenerate,
      onEditVersionChange: () => setEditVersion((v) => v + 1),
    });

  // ============================================
  // INITIALIZATION EFFECTS
  // ============================================

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

  // Initialize chat
  useEffect(() => {
    const initializeChat = async () => {
      try {
        // Load agent config
        const agentConfigResponse = await fetchWithAuth(`/api/pages/${page.id}/agent-config`);
        if (agentConfigResponse.ok) {
          const config = await agentConfigResponse.json();
          setAgentConfig(config);
          if (config.aiProvider) setSelectedProvider(config.aiProvider);
          if (config.aiModel) setSelectedModel(config.aiModel);
        }

        // Create new conversation (fresh start on page load)
        const newConvResponse = await fetchWithAuth(`/api/ai/page-agents/${page.id}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        if (newConvResponse.ok) {
          const newConvData = await newConvResponse.json();
          setCurrentConversationId(newConvData.conversationId);
          setInitialMessages([]);
          setMessages([]);
        } else {
          setInitialMessages([]);
          setMessages([]);
        }

        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize chat:', error);
        setInitialMessages([]);
        setMessages([]);
        setIsInitialized(true);
      }
    };

    setIsInitialized(false);
    setInitialMessages([]);
    setCurrentConversationId(null);
    initializeChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Register streaming state with editing store
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
    return () => {
      useEditingStore.getState().endStreaming(componentId);
    };
  }, [status, page.id]);

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // ============================================
  // HANDLERS
  // ============================================

  const handleSendMessage = useCallback(() => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    if (!input.trim()) return;

    const currentDrive = drives.find((d) => d.id === driveId);
    const pagePathInfo = buildPagePath(tree, page.id, driveId);

    sendMessage(
      { text: input },
      {
        body: {
          chatId: page.id,
          conversationId: currentConversationId,
          selectedProvider,
          selectedModel,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
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
        },
      }
    );
    setInput('');
    inputAreaRef.current?.clear();
    setTimeout(() => messagesAreaRef.current?.scrollToBottom(), 100);
  }, [
    isReadOnly,
    input,
    drives,
    driveId,
    tree,
    page,
    sendMessage,
    currentConversationId,
    selectedProvider,
    selectedModel,
    mcpToolSchemas,
  ]);

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
    return (
      <ProviderSetupCard
        mode="inline"
        onApiKeySubmit={(provider) => {
          setSelectedProvider(provider);
          // API key submission would need backend handling
        }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
        <div className="p-4 border-b border-[var(--separator)] space-y-3">
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

            {/* Chat tab actions */}
            {activeTab === 'chat' && (
              <div className="flex items-center gap-3">
                <AiUsageMonitor pageId={page.id} compact />

                <MCPToggle
                  isDesktop={isDesktop}
                  mcpEnabled={mcpEnabled}
                  runningServers={runningServers}
                  onToggle={setMcpEnabled}
                />

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => createConversation()}
                  className="flex items-center space-x-2"
                >
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">New Chat</span>
                </Button>
              </div>
            )}

            {/* Settings tab actions */}
            {activeTab === 'settings' && (
              <Button
                onClick={() => agentSettingsRef.current?.submitForm()}
                disabled={isSettingsSaving}
                className="min-w-[100px] sm:min-w-[120px]"
              >
                {isSettingsSaving ? (
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
          <ChatMessagesArea
            ref={messagesAreaRef}
            messages={messages}
            isLoading={isLoading}
            isStreaming={isStreaming}
            assistantName="Assistant"
            emptyMessage="Start a conversation with the AI assistant"
            onEdit={!isReadOnly ? handleEdit : undefined}
            onDelete={!isReadOnly ? handleDelete : undefined}
            onRetry={!isReadOnly ? handleRetry : undefined}
            lastAssistantMessageId={lastAssistantMessageId}
            lastUserMessageId={lastUserMessageId}
            editVersion={editVersion}
            isReadOnly={isReadOnly}
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
            placeholder={isReadOnly ? 'View only - cannot send messages' : 'Message AI...'}
            driveId={driveId}
            error={error}
            showError={showError}
            onClearError={() => setShowError(false)}
            isReadOnly={isReadOnly}
            readOnlyMessage="You do not have permission to send messages in this AI chat"
          />
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="flex-1 overflow-hidden">
          <PageAgentHistoryTab
            conversations={conversations}
            currentConversationId={currentConversationId}
            onSelectConversation={loadConversation}
            onCreateNew={() => createConversation()}
            onDeleteConversation={deleteConversation}
            isLoading={isLoadingConversations}
          />
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="flex-1 overflow-auto">
          <PageAgentSettingsTab
            ref={agentSettingsRef}
            pageId={page.id}
            config={agentConfig}
            onConfigUpdate={setAgentConfig}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onProviderChange={setSelectedProvider}
            onModelChange={setSelectedModel}
            isProviderConfigured={isProviderConfigured}
            onSavingChange={setIsSettingsSaving}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AiChatView;

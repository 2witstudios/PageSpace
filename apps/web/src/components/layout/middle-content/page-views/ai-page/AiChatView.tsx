/**
 * AiChatView - Page-level AI agent chat view
 *
 * This component provides a chat interface for AI_CHAT page types.
 * It uses the Agent engine for conversation management, independent
 * from the Global Assistant.
 */

import { TreePage } from '@/hooks/usePageTree';
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Settings, MessageSquare, History, Plus, Save } from 'lucide-react';
import { UIMessage } from 'ai';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { buildPagePath } from '@/lib/tree/tree-utils';
import { useDriveStore } from '@/hooks/useDrive';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { PageAgentSettingsTab, PageAgentHistoryTab, type PageAgentSettingsTabRef } from '@/components/ai/page-agents';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { VoiceModeDock } from '@/components/ai/voice/VoiceModeDock';
import { useSWRConfig } from 'swr';

import { clearActiveStreamId } from '@/lib/ai/core/client';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';

// Shared hooks and components
import {
  useMCPTools,
  useMessageActions,
  useProviderSettings,
  useConversations,
  useChatTransport,
  useStreamingRegistration,
  useChatStop,
  AgentConfig,
} from '@/lib/ai/shared';
import {
  ProviderSetupCard,
} from '@/components/ai/shared/chat';
import { AiUsageMonitor, TasksDropdown } from '@/components/ai/shared';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import {
  ChatLayout,
  type ChatLayoutRef,
} from '@/components/ai/chat/layouts';
import { ChatInput, type ChatInputRef } from '@/components/ai/chat/input';
import { useImageAttachments } from '@/lib/ai/shared/hooks/useImageAttachments';
import { hasVisionCapability } from '@/lib/ai/core/vision-models';
import { parseConsentError } from '@/lib/ai/shared/error-messages';
import { CloudProviderConsentDialog } from '@/components/ai/consent/CloudProviderConsentDialog';

interface AiChatViewProps {
  page: TreePage;
}

const VOICE_OWNER: VoiceModeOwner = 'ai-page';

const AiChatView: React.FC<AiChatViewProps> = ({ page }) => {
  const params = useParams();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const { cache } = useSWRConfig();
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
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [lastAIResponse, setLastAIResponse] = useState<{ id: string; text: string } | null>(null);
  const [isOpenAIConfigured, setIsOpenAIConfigured] = useState(false);
  const [consentProvider, setConsentProvider] = useState<string | null>(null);

  // Voice mode state
  const isVoiceModeEnabled = useVoiceModeStore((s) => s.isEnabled);
  const voiceOwner = useVoiceModeStore((s) => s.owner);
  const enableVoiceMode = useVoiceModeStore((s) => s.enable);
  const disableVoiceMode = useVoiceModeStore((s) => s.disable);
  const isVoiceModeActive = isVoiceModeEnabled && voiceOwner === VOICE_OWNER;

  // Display preferences
  const { preferences: displayPreferences } = useDisplayPreferences();

  // Image attachments for vision support
  const { attachments, addFiles, removeFile, clearFiles, getFilesForSend } = useImageAttachments();

  // Refs
  const chatLayoutRef = useRef<ChatLayoutRef>(null);
  const inputRef = useRef<ChatInputRef>(null);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);
  const prevConversationIdRef = useRef<string | null>(null);

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

  const hasVision = hasVisionCapability(selectedModel || '');

  const {
    isDesktop,
    runningServers,
    runningServerNames,
    mcpToolSchemas,
    enabledServerCount,
    isServerEnabled,
    setServerEnabled,
    allServersEnabled,
    setAllServersEnabled,
  } = useMCPTools({ conversationId: currentConversationId });

  // Get web search setting from global assistant settings store
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);

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
  // Use conversation ID for stream tracking (falls back to page.id before conversation is created)
  const streamTrackingId = currentConversationId || page.id;

  const transport = useChatTransport(streamTrackingId, '/api/ai/chat');

  const chatConfig = useMemo(
    () => !transport ? null : ({
      id: page.id,
      messages: initialMessages,
      transport,
      experimental_throttle: 100,
      onError: (error: Error) => {
        const provider = parseConsentError(error.message);
        if (provider) {
          setConsentProvider(provider);
          return;
        }
        console.error('AiChatView: Chat error:', error);
      },
    }),
    [page.id, transport, initialMessages]
  );

  const { messages, sendMessage, status, error, regenerate, setMessages, stop: chatStop } =
    useChat(chatConfig || {});

  const isStreaming = status === 'submitted' || status === 'streaming';
  const stop = useChatStop(streamTrackingId, chatStop);
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
  useStreamingRegistration(
    `ai-chat-${page.id}`,
    isStreaming,
    { pageId: page.id, componentName: 'AiChatView' }
  );

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  useEffect(() => {
    if (!isVoiceModeActive) {
      setShowVoiceSettings(false);
    }
  }, [isVoiceModeActive]);

  // Check if OpenAI is configured (required for voice mode)
  useEffect(() => {
    const checkOpenAI = async () => {
      try {
        const response = await fetchWithAuth('/api/ai/settings');
        if (response.ok) {
          const data = await response.json();
          setIsOpenAIConfigured(data.providers?.openai?.isConfigured ?? false);
        }
      } catch {
        setIsOpenAIConfigured(false);
      }
    };
    checkOpenAI();
  }, []);

  // Track last AI response for voice mode TTS
  useEffect(() => {
    if (!isVoiceModeActive || isStreaming) return;

    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistantMsg) {
      const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') || [];
      const text = textParts.map((p) => (p as { text: string }).text).join(' ');
      if (text.trim()) {
        setLastAIResponse((current) =>
          current?.id === lastAssistantMsg.id
            ? current
            : { id: lastAssistantMsg.id, text }
        );
      }
    }
  }, [messages, isStreaming, isVoiceModeActive]);

  // ============================================
  // HANDLERS
  // ============================================

  const buildFreshPageContext = useCallback(async () => {
    const currentDrive = drives.find((drive) => drive.id === driveId);
    const treeCacheKey = `/api/drives/${encodeURIComponent(driveId)}/pages`;
    const treeCacheValue = cache.get(treeCacheKey) as { data?: TreePage[] } | undefined;
    const cachedTree = Array.isArray(treeCacheValue?.data) ? treeCacheValue.data : [];
    const pagePathInfo = buildPagePath(cachedTree, page.id, driveId);
    let breadcrumbs: string[] = pagePathInfo?.breadcrumbs || [driveId, page.title];
    let pagePath = pagePathInfo?.path || `/${driveId}/${page.title}`;
    let parentPath = pagePathInfo?.parentPath || `/${driveId}`;

    if (!pagePathInfo) {
      try {
        const breadcrumbsResponse = await fetchWithAuth(`/api/pages/${page.id}/breadcrumbs`);
        if (breadcrumbsResponse.ok) {
          const breadcrumbItems = (await breadcrumbsResponse.json()) as Array<{ title?: string }>;
          const breadcrumbTitles = breadcrumbItems
            .map((item) => item.title?.trim())
            .filter((title): title is string => Boolean(title));

          if (breadcrumbTitles.length > 0) {
            breadcrumbs = [driveId, ...breadcrumbTitles];
            pagePath = `/${driveId}/${breadcrumbTitles.map((title) => encodeURIComponent(title)).join('/')}`;
            if (breadcrumbTitles.length > 1) {
              parentPath = `/${driveId}/${breadcrumbTitles
                .slice(0, -1)
                .map((title) => encodeURIComponent(title))
                .join('/')}`;
            }
          }
        }
      } catch (error) {
        console.warn('Failed to fetch breadcrumbs for AI page context:', error);
      }
    }

    return {
      pageId: page.id,
      pageTitle: page.title,
      pageType: page.type,
      pagePath,
      parentPath,
      breadcrumbs,
      driveId: currentDrive?.id,
      driveName: currentDrive?.name || driveId,
      driveSlug: currentDrive?.slug,
    };
  }, [cache, drives, driveId, page.id, page.title, page.type]);

  const sendMessageWithContext = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const files = getFilesForSend();
    if (!trimmed && files.length === 0) {
      return;
    }

    const pageContext = await buildFreshPageContext();

    sendMessage(
      { text: trimmed, files: files.length > 0 ? files : undefined },
      {
        body: {
          chatId: page.id,
          conversationId: currentConversationId,
          selectedProvider,
          selectedModel,
          isReadOnly,
          webSearchEnabled,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
          pageContext,
        },
      }
    );
  }, [
    buildFreshPageContext,
    sendMessage,
    page.id,
    currentConversationId,
    selectedProvider,
    selectedModel,
    isReadOnly,
    webSearchEnabled,
    mcpToolSchemas,
    getFilesForSend,
  ]);

  const handleSendMessage = useCallback(() => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    if (!input.trim() && attachments.length === 0) return;

    void sendMessageWithContext(input);
    setInput('');
    clearFiles();
    inputRef.current?.clear();
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  }, [
    isReadOnly,
    input,
    attachments.length,
    sendMessageWithContext,
    clearFiles,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback((text: string) => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    if (!text.trim()) return;

    void sendMessageWithContext(text);
  }, [
    isReadOnly,
    sendMessageWithContext,
  ]);

  // Voice mode toggle handler
  const handleVoiceModeToggle = useCallback(() => {
    if (isVoiceModeActive) {
      disableVoiceMode();
      setShowVoiceSettings(false);
    } else {
      enableVoiceMode(VOICE_OWNER);
    }
  }, [isVoiceModeActive, enableVoiceMode, disableVoiceMode]);

  const handleUndoSuccess = useCallback(async () => {
    if (!currentConversationId) return;
    try {
      const res = await fetchWithAuth(
        `/api/ai/page-agents/${page.id}/conversations/${currentConversationId}/messages`
      );
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
      }
    } catch (error) {
      console.error('Failed to refresh messages after undo:', error);
    }
  }, [currentConversationId, page.id, setMessages]);

  // Handle consent grant — call API, dismiss dialog, retry last message
  const handleConsentGrant = useCallback(async () => {
    if (!consentProvider) return;
    try {
      await fetchWithAuth('/api/ai/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: consentProvider }),
      });
      setConsentProvider(null);
      setShowError(false);
      // Retry the last user message if one exists
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg) {
        const textParts = lastUserMsg.parts?.filter((p) => p.type === 'text') || [];
        const text = textParts.map((p) => (p as { text: string }).text).join(' ');
        if (text) {
          void sendMessageWithContext(text);
        }
      }
    } catch (err) {
      console.error('Failed to grant consent:', err);
      toast.error('Failed to grant consent. Please try again.');
    }
  }, [consentProvider, messages, sendMessageWithContext]);

  // Pull-up refresh handler for mobile - check for missed messages
  const handlePullUpRefresh = useCallback(async () => {
    if (!currentConversationId) return;
    try {
      const res = await fetchWithAuth(
        `/api/ai/page-agents/${page.id}/conversations/${currentConversationId}/messages`
      );
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
      }
    } catch (error) {
      console.error('Failed to refresh messages:', error);
    }
  }, [currentConversationId, page.id, setMessages]);

  // App state recovery - refresh messages when returning from background
  // This catches completed AI responses that finished while the app was backgrounded
  useAppStateRecovery({
    onResume: handlePullUpRefresh,
    enabled: !isStreaming && currentConversationId !== null,
  });

  // Clean up stream tracking when conversation changes or on unmount
  // Uses prevConversationIdRef to track the previous conversation and clear its stream ID
  useEffect(() => {
    // Clear previous conversation's stream ID when switching conversations
    if (prevConversationIdRef.current && prevConversationIdRef.current !== streamTrackingId) {
      clearActiveStreamId({ chatId: prevConversationIdRef.current });
    }
    prevConversationIdRef.current = streamTrackingId;

    // Clear current conversation's stream ID on unmount
    return () => {
      clearActiveStreamId({ chatId: streamTrackingId });
    };
  }, [streamTrackingId]);

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
                {displayPreferences.showTokenCounts && (
                  <AiUsageMonitor pageId={page.id} compact />
                )}

                <TasksDropdown messages={messages} driveId={driveId} />

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => createConversation()}
                  className="flex items-center gap-2"
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
        <TabsContent value="chat" className="flex flex-col flex-1 overflow-hidden relative">
          <ChatLayout
            ref={chatLayoutRef}
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSend={handleSendMessage}
            onStop={stop}
            isStreaming={isStreaming}
            isLoading={isLoading}
            disabled={!isAnyProviderConfigured}
            placeholder={isReadOnly ? 'View only - cannot send messages' : 'Message AI...'}
            driveId={driveId}
            error={error}
            showError={showError}
            onClearError={() => setShowError(false)}
            welcomeTitle={`Chat with ${page.title}`}
            welcomeSubtitle={agentConfig?.systemPrompt ? 'Ask me anything!' : 'Start a conversation with the AI assistant'}
            onEdit={!isReadOnly ? handleEdit : undefined}
            onDelete={!isReadOnly ? handleDelete : undefined}
            onRetry={!isReadOnly ? handleRetry : undefined}
            lastAssistantMessageId={lastAssistantMessageId}
            lastUserMessageId={lastUserMessageId}
            isReadOnly={isReadOnly}
            onUndoSuccess={handleUndoSuccess}
            onPullUpRefresh={handlePullUpRefresh}
            mcpRunningServers={runningServers}
            mcpServerNames={runningServerNames}
            mcpEnabledCount={enabledServerCount}
            mcpAllEnabled={allServersEnabled}
            onMcpToggleAll={setAllServersEnabled}
            isMcpServerEnabled={isServerEnabled}
            onMcpServerToggle={setServerEnabled}
            showMcp={isDesktop}
            renderInput={(props) => (
              isVoiceModeActive ? (
                <VoiceModeDock
                  owner={VOICE_OWNER}
                  onSend={handleVoiceSend}
                  aiResponse={lastAIResponse}
                  isAIStreaming={isStreaming}
                  showSettings={showVoiceSettings}
                  onToggleSettings={() => setShowVoiceSettings((s) => !s)}
                  onClose={() => setShowVoiceSettings(false)}
                />
              ) : (
                <ChatInput
                  ref={inputRef}
                  value={props.value}
                  onChange={props.onChange}
                  onSend={props.onSend}
                  onStop={props.onStop}
                  isStreaming={props.isStreaming}
                  disabled={props.disabled}
                  placeholder={props.placeholder}
                  driveId={props.driveId}
                  crossDrive={props.crossDrive}
                  mcpRunningServers={props.mcpRunningServers}
                  mcpServerNames={props.mcpServerNames}
                  mcpEnabledCount={props.mcpEnabledCount}
                  mcpAllEnabled={props.mcpAllEnabled}
                  onMcpToggleAll={props.onMcpToggleAll}
                  isMcpServerEnabled={props.isMcpServerEnabled}
                  onMcpServerToggle={props.onMcpServerToggle}
                  showMcp={props.showMcp}
                  popupPlacement={props.inputPosition === 'centered' ? 'bottom' : 'top'}
                  selectedProvider={selectedProvider}
                  selectedModel={selectedModel}
                  onProviderModelChange={(provider, model) => {
                    setSelectedProvider(provider);
                    setSelectedModel(model);
                  }}
                  onVoiceModeClick={handleVoiceModeToggle}
                  isVoiceModeActive={isVoiceModeActive}
                  isVoiceModeAvailable={isOpenAIConfigured}
                  attachments={attachments}
                  onAddFiles={addFiles}
                  onRemoveFile={removeFile}
                  hasVision={hasVision}
                />
              )
            )}
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

      <CloudProviderConsentDialog
        provider={consentProvider}
        onConsent={handleConsentGrant}
        onCancel={() => setConsentProvider(null)}
      />
    </div>
  );
};

export default React.memo(
  AiChatView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.title === nextProps.page.title &&
    prevProps.page.type === nextProps.page.type
);

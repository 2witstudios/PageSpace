'use client';

/**
 * AgentPageView — the drive AI_CHAT page, restored to `AiChatView`'s shape.
 *
 * **Chat | History | Settings as real tabs** (`grid grid-cols-3 max-w-lg`
 * pills with icons, in the `p-4 border-b` header block — the same `Tabs`
 * defaults every other tabbed surface in the app uses), History as a
 * FULL-HEIGHT tab (`PageAgentHistoryTab` is written `h-full` + virtualized —
 * a popover gave it no height to resolve against), and Save pinned in the
 * header row beside the tabs.
 *
 * **The one addition over the old page: the Chat tab hosts the PANE GRID.**
 * A conversation born into a session renders `AgentPanes` — split-capable,
 * every pane sharing the session's ONE sandbox by construction. Sessions are
 * capability-shaped (they own sandboxes), so:
 * - session users (the same admin gate every session surface uses) get new
 *   conversations born WITH a session, and the grid;
 * - everyone else gets the plain chat, exactly the pre-session page.
 * A pre-session conversation (sessionId null) also renders plain — binding is
 * set at creation and permanent, so an old thread cannot join a workspace
 * (that would be a rebind; the model's escape hatch is forking, later).
 *
 * There is NO sandbox chrome here: no status chip, no Add-shell. Provisioning
 * is lazy and automatic (first tool call / shell open), and shells live in
 * panes, opened from the pane picker like everywhere else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ExternalLink,
  History,
  Loader2,
  MessageSquare,
  Save,
  Settings,
  Webhook,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  PageAgentSettingsTab,
  PageAgentHistoryTab,
  type PageAgentSettingsTabRef,
} from '@/components/ai/page-agents';
import { AgentIntegrationsPanel } from '@/components/ai/page-agents/AgentIntegrationsPanel';
import { PageWebhooksDialog } from '@/components/shared/PageWebhooksDialog';
import { useProviderSettings } from '@/lib/ai/shared/hooks/useProviderSettings';
import { useConversations } from '@/lib/ai/shared/hooks/useConversations';
import { buildAgentSelectionUrl } from '@/lib/agents/agent-selection';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAuth } from '@/hooks/useAuth';
import { usePermissionsCheck } from './usePermissionsCheck';
import {
  useResolvedConversation,
  createPageConversation,
  type ResolvedConversation,
} from './useResolvedConversation';
import { useResolvedAgent } from './useResolvedAgent';
import SessionChat from './chat/SessionChat';
import AgentPanes from './panes/AgentPanes';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { TreePage } from '@/hooks/usePageTree';
import type { AgentConfig } from '@/lib/ai/shared/chat-types';

export interface AgentPageViewProps {
  page: TreePage;
}

export default function AgentPageView({ page }: AgentPageViewProps) {
  const { user, isLoading: authLoading } = useAuth();
  // The same gate every session surface uses — the server still decides
  // (drive membership + code-execution) on every spawn.
  const canUseSessions = user?.role === 'admin';

  const { resolved: initialResolved } = useResolvedConversation(page.id, {
    driveId: page.driveId,
    canUseSessions,
    // A hard refresh starts `user` (and so `canUseSessions`) undefined/false
    // before the role loads — resolving then would mint the agent's first
    // conversation as permanently session-less. Wait it out.
    authLoading,
  });
  const [override, setOverride] = useState<ResolvedConversation | null>(null);
  // The conversation on screen: the user's own switching (history select, new,
  // delete-replacement) wins over the initial resolution.
  const current = override ?? initialResolved;

  const [activeTab, setActiveTab] = useState<string>('chat');
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);

  const isReadOnly = usePermissionsCheck(page.id, user?.id);

  const { agent, isLoading: agentLoading, error: agentError, retry: retryAgent } = useResolvedAgent(page.id);

  // The Settings tab's data: PageAgentSettingsTab renders its loading state
  // until `config` arrives, so this fetch is what makes Settings (and Save)
  // work at all — the AiChatView effect this page's rewrite dropped, restored.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetchWithAuth(`/api/pages/${page.id}/agent-config`, {
          signal: controller.signal,
        });
        if (response.ok) setAgentConfig(await response.json());
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Failed to load agent config:', error);
      }
    })();
    return () => controller.abort();
  }, [page.id]);

  const {
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings({ pageId: page.id });

  const newConversation = useCallback(
    async (reuseSessionId?: string | null) => {
      const created = await createPageConversation({
        agentId: page.id,
        driveId: page.driveId,
        canUseSessions,
        sessionId: reuseSessionId ?? null,
      });
      setOverride(created);
      setActiveTab('chat');
      return created;
    },
    [page.id, page.driveId, canUseSessions],
  );

  const {
    conversations,
    isLoading: isLoadingConversations,
    deleteConversation,
    refreshConversations,
  } = useConversations({
    agentId: page.id,
    currentConversationId: current?.conversationId ?? null,
    // History needs the list; chat needs it too so a history-selected thread
    // can be looked up for its session.
    enabled: activeTab === 'history' || activeTab === 'chat',
    onConversationDelete: () => {
      // `onConversationDelete` only fires for the CURRENT conversation, so
      // `current` here is exactly the deleted thread. If it was session-bound,
      // mint the replacement INTO that session — never spawn a new one, which
      // would abandon a live session (issue #2263, finding 4) — and prune the
      // pane that was showing the now-deleted id, wherever it lives in the
      // grid (not necessarily the active pane: the grid's own selection and
      // this page's `current` are independent state).
      const deletedConversationId = current?.conversationId ?? null;
      const sessionId = current?.sessionId ?? null;
      void (async () => {
        const created = await newConversation(sessionId);
        if (sessionId && deletedConversationId) {
          useAgentWorkspaceStore.getState().replaceConversation(sessionId, deletedConversationId, {
            kind: 'chat',
            name: 'New conversation',
            targetId: created.conversationId,
            agentPageId: page.id,
          });
        }
      })();
    },
  });

  const handleSelectConversation = useCallback(
    (id: string) => {
      const selected = conversations.find((conversation) => conversation.id === id);
      setOverride({ conversationId: id, sessionId: selected?.sessionId ?? null });
      setActiveTab('chat');
    },
    [conversations],
  );

  const handleCreateNew = useCallback(async () => {
    await newConversation();
    refreshConversations();
  }, [newConversation, refreshConversations]);

  const toggleConversationShare = useCallback(
    async (targetConversationId: string, isShared: boolean) => {
      try {
        const response = await fetchWithAuth(
          `/api/ai/page-agents/${page.id}/conversations/${targetConversationId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isShared }),
          },
        );
        if (!response.ok) console.error('Failed to update conversation sharing');
      } catch (error) {
        console.error('Failed to update conversation sharing:', error);
      }
    },
    [page.id],
  );

  const openInAgentsHref = useMemo(
    () =>
      buildAgentSelectionUrl({
        driveId: page.driveId,
        sessionId: current?.sessionId ?? null,
        agentId: page.id,
        conversationId: current?.conversationId ?? null,
      }),
    [page.driveId, page.id, current],
  );

  if (!current) {
    return (
      <div data-testid="agent-page-view-loading" className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div data-testid="agent-page-view" className="flex h-full flex-col">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col gap-0">
        <div className="border-b border-[var(--separator)] p-4">
          <div className="flex items-center justify-between">
            <TabsList className="grid max-w-lg grid-cols-3">
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

            <div className="flex items-center gap-3">
              {activeTab === 'chat' && canUseSessions && (
                <Link
                  href={openInAgentsHref}
                  className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  Open in Agents
                </Link>
              )}

              {activeTab === 'settings' && (
                <Button
                  onClick={() => agentSettingsRef.current?.submitForm()}
                  disabled={isSettingsSaving}
                  className="min-w-[100px] sm:min-w-[120px]"
                >
                  {isSettingsSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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

              {/* Deliberately not permission-gated: the dialog itself explains the
                  owner/admin requirement, so the feature stays discoverable. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWebhooksOpen(true)}
                title="Incoming Webhooks"
                aria-label="Incoming Webhooks"
                className="px-2 text-muted-foreground hover:text-foreground"
              >
                <Webhook className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Chat Tab — the pane grid for a session-bound conversation, ONLY for
            users with the session capability: a non-admin can land on a shared
            session-bound thread (review M2), and handing them a grid whose
            every affordance 403s — except last-pane-close, which destroys the
            session — is worse than the plain chat they can actually use. */}
        <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          {current.sessionId && canUseSessions ? (
            <AgentPanes
              key={current.sessionId}
              sessionId={current.sessionId}
              driveId={page.driveId}
              initialConversation={{
                conversationId: current.conversationId,
                agentPageId: page.id,
                name: 'Conversation',
              }}
              chatContext="page"
              isReadOnly={isReadOnly}
              onSessionEnded={() => void handleCreateNew()}
            />
          ) : agentLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : !agent ? (
            // Loading FINISHED and there is still no agent — SWR stops retrying
            // after a genuine failure, so a combined guard would leave the user
            // watching a spinner that never resolves.
            <div
              data-testid="agent-page-view-error"
              role="alert"
              className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
            >
              <AlertCircle className="size-5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Couldn&apos;t load this agent</p>
                <p className="text-xs text-muted-foreground">
                  {agentError?.message ?? 'The agent could not be found, or you no longer have access to it.'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={retryAgent}>
                Try again
              </Button>
            </div>
          ) : (
            <SessionChat
              agent={agent}
              conversationId={current.conversationId}
              context="page"
              isReadOnly={isReadOnly}
            />
          )}
        </TabsContent>

        {/* History Tab — full height; the component is h-full + virtualized. */}
        <TabsContent value="history" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <PageAgentHistoryTab
            conversations={conversations}
            currentConversationId={current.conversationId}
            onSelectConversation={handleSelectConversation}
            onCreateNew={() => void handleCreateNew()}
            onDeleteConversation={(id) => void deleteConversation(id)}
            onToggleShare={toggleConversationShare}
            isLoading={isLoadingConversations}
          />
        </TabsContent>

        {/* Settings Tab — Save lives in the header row, pinned. */}
        <TabsContent value="settings" className="mt-0 min-h-0 flex-1 overflow-auto">
          <PageAgentSettingsTab
            ref={agentSettingsRef}
            pageId={page.id}
            driveId={page.driveId}
            config={agentConfig}
            onConfigUpdate={setAgentConfig}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onProviderChange={setSelectedProvider}
            onModelChange={setSelectedModel}
            isProviderConfigured={isProviderConfigured}
            onSavingChange={setIsSettingsSaving}
          />
          <div className="px-4 pb-4">
            <AgentIntegrationsPanel pageId={page.id} driveId={page.driveId} />
          </div>
        </TabsContent>
      </Tabs>

      <PageWebhooksDialog
        open={webhooksOpen}
        onOpenChange={setWebhooksOpen}
        pageId={page.id}
        pageType={page.type}
      />
    </div>
  );
}

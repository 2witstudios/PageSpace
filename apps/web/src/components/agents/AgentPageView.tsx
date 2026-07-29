'use client';

/**
 * AgentPageView — the AI_CHAT page's rendering of `AgentView`.
 *
 * Replaces `AiChatView.tsx` (deleted in this phase). Its chat/history/welcome
 * internals are replaced outright by `AgentView`/`SessionChat`; the page-level
 * scaffolding AiChatView owned that `AgentView` itself has no business
 * knowing about — which conversation is on screen, read-only gating, the
 * conversation picker, and the settings/integrations/webhooks tab — lives
 * here, thin, and is handed to `AgentView` as resolved props/slots.
 *
 * `PageAgentSettingsTab` / `AgentIntegrationsPanel` / `PageWebhooksDialog` /
 * `PageAgentHistoryTab` are re-hosted UNCHANGED from AiChatView — each is
 * already self-contained, so nothing about them needed to change for the
 * unification.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createId } from '@paralleldrive/cuid2';
import { ExternalLink, History, Loader2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useAuth } from '@/hooks/useAuth';
import { useResolvedConversation } from './useResolvedConversation';
import AgentView from './AgentView';
import type { TreePage } from '@/hooks/usePageTree';
import type { AgentConfig } from '@/lib/ai/shared/chat-types';

export interface AgentPageViewProps {
  page: TreePage;
}

export default function AgentPageView({ page }: AgentPageViewProps) {
  const { user } = useAuth();
  const { conversationId: resolvedConversationId } = useResolvedConversation(page.id);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);

  // Adopt the resolved conversation once, on this mount only — CenterPanel
  // keys this component by page.id, so a genuinely different agent is a
  // fresh mount, not a prop change this effect needs to react to again.
  useEffect(() => {
    if (resolvedConversationId !== null) setConversationId(resolvedConversationId);
  }, [resolvedConversationId]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth(`/api/pages/${page.id}/permissions/check`);
        if (cancelled || !response.ok) return;
        const permissions = await response.json();
        if (!cancelled) setIsReadOnly(!permissions.canEdit);
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, page.id]);

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

  const { conversations, isLoading: isLoadingConversations, createConversation, deleteConversation } =
    useConversations({
      agentId: page.id,
      currentConversationId: conversationId,
      enabled: historyOpen,
      onConversationCreate: (newId) => {
        conversationMessagesActions.seedConversation(newId);
        setConversationId(newId);
        setHistoryOpen(false);
      },
      onConversationDelete: () => {
        const nextId = createId();
        conversationMessagesActions.seedConversation(nextId);
        setConversationId(nextId);
      },
    });

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

  const handleSelectConversation = useCallback((id: string) => {
    setConversationId(id);
    setHistoryOpen(false);
  }, []);

  if (!conversationId) {
    return (
      <div data-testid="agent-page-view-loading" className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <AgentView
        agentId={page.id}
        conversationId={conversationId}
        context="page"
        isReadOnly={isReadOnly}
        headerExtra={
          <>
            <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" className="shrink-0" aria-label="Conversation history">
                  <History className="size-3.5" />
                  History
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <PageAgentHistoryTab
                  conversations={conversations}
                  currentConversationId={conversationId}
                  onSelectConversation={handleSelectConversation}
                  onCreateNew={() => void createConversation()}
                  onDeleteConversation={(id) => void deleteConversation(id)}
                  onToggleShare={toggleConversationShare}
                  isLoading={isLoadingConversations}
                />
              </PopoverContent>
            </Popover>
            <Link
              href={buildAgentSelectionUrl({ driveId: page.driveId, agentId: page.id, conversationId })}
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              Open in Agents
            </Link>
          </>
        }
        settingsTab={
          <div className="space-y-4">
            <div className="flex justify-end gap-2 px-4 pt-4">
              <Button size="sm" variant="outline" onClick={() => setWebhooksOpen(true)}>
                <Webhook className="size-3.5" />
                Webhooks
              </Button>
              <Button
                size="sm"
                onClick={() => agentSettingsRef.current?.submitForm()}
                disabled={isSettingsSaving}
              >
                {isSettingsSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {isSettingsSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
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
          </div>
        }
      />
      <PageWebhooksDialog
        open={webhooksOpen}
        onOpenChange={setWebhooksOpen}
        pageId={page.id}
        pageType={page.type}
      />
    </>
  );
}

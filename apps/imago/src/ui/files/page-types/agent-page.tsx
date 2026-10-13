'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, Cable, History, KeyRound, MessageSquare, Plus, Settings, Shield, Wrench, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import Link from '@/retained-adapters/link';
import { RetainedChat } from '@/retained-adapters/retained-chat';
import { AgentSettingsMenu, type AgentSettingsMenuItem } from '@/retained/components/ai/page-agents/AgentSettingsMenu';
import PageAgentHistoryTab from '@/retained/components/ai/page-agents/PageAgentHistoryTab';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { buildAgentSelectionUrl } from '@/retained/lib/agents/agent-selection';
import { useAgentConversations } from '@/ui/chat/use-chat-data/use-chat-data';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import type { PageTypeProps } from './shared';

/** The three faces of an agent page's middle (C-Files-AiChat): the Agent views tabs. */
export type AgentView = 'chat' | 'history' | 'settings';

const AGENT_VIEWS: readonly AgentView[] = ['chat', 'history', 'settings'];
const TAB_PARAM = 'tab';

/** The view a `?tab=` value names; anything else (or none) is the Chat tab. */
export const agentViewFrom = (value: string | null): AgentView => AGENT_VIEWS.find((view) => view === value) ?? 'chat';

/**
 * The five category rows of the Settings tab, with the board's copy. Their sub-nav
 * (what a row opens) is IMC-3.12, so a row does nothing yet.
 */
export const agentSettingsItems = (): AgentSettingsMenuItem[] => [
  { key: 'behavior', title: 'Behavior', description: 'Model, instructions, identity, and workspace context', icon: Bot },
  { key: 'access', title: 'Access', description: 'Drive membership and the drives this agent can reach', icon: Shield },
  { key: 'tools', title: 'Tools', description: 'Sandbox, default tools, and how tools are exposed', icon: Wrench },
  { key: 'integrations', title: 'Integrations', description: 'Integration tools and incoming webhooks', icon: Cable },
  { key: 'accounts', title: 'Accounts', description: 'API keys this agent can use without ever seeing them', icon: KeyRound },
];

/** A failed change to a conversation says so; the list stays as the server has it. */
const reportFailure = (error: unknown): void => {
  toast.error(error instanceof Error ? error.message : 'Something went wrong');
};

const tabClass = (on: boolean): string =>
  `flex h-segment cursor-pointer items-center gap-2 rounded-md border-0 px-3 text-xs ${on ? 'bg-background font-medium text-ink shadow-1' : 'bg-transparent text-ink-muted'}`;

/** The 44px Agent views strip: Chat / History / settings tabs, Open in Agents, and a new conversation. */
function AgentViewsStrip({
  title,
  driveId,
  pageId,
  view,
  onSelect,
  onNewConversation,
}: {
  readonly title: string;
  readonly driveId: string;
  readonly pageId: string;
  readonly view: AgentView;
  readonly onSelect: (view: AgentView) => void;
  readonly onNewConversation: () => void;
}) {
  const tabs: readonly { readonly view: AgentView; readonly label: string; readonly Icon: LucideIcon }[] = [
    { view: 'chat', label: 'Chat', Icon: MessageSquare },
    { view: 'history', label: 'History', Icon: History },
    { view: 'settings', label: `${title} settings`, Icon: Settings },
  ];
  return (
    <ToolbarStrip label="Agent views">
      <div role="tablist" aria-label="Agent" className="flex rounded-lg bg-fill p-px">
        {tabs.map(({ view: tab, label, Icon }) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view === tab}
            className={tabClass(view === tab)}
            onClick={() => onSelect(tab)}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <Link
        href={buildAgentSelectionUrl({ driveId, agentId: pageId })}
        className="flex h-segment items-center gap-2 rounded-md px-3 text-xs text-ink-muted"
      >
        Open in Agents
      </Link>
      <button
        type="button"
        aria-label="Start a new conversation"
        title="Start a new conversation"
        onClick={onNewConversation}
        className="flex h-segment w-segment items-center justify-center rounded-md border-0 bg-transparent text-ink-muted"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </ToolbarStrip>
  );
}

/** The History tab: the agent's conversations, their Shared switch and delete, over the classic list. */
function AgentHistory({
  pageId,
  currentConversationId,
  onOpen,
  onDeleted,
}: {
  readonly pageId: string;
  readonly currentConversationId: string | null;
  readonly onOpen: (conversationId: string) => void;
  readonly onDeleted: (conversationId: string) => void;
}) {
  const { conversations, revalidate, isLoading } = useAgentConversations(pageId);

  const toggleShare = useCallback(
    async (conversationId: string, isShared: boolean) => {
      const response = await fetchWithAuth(`/api/ai/page-agents/${pageId}/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isShared }),
      });
      if (!response.ok) throw new Error('Failed to update conversation sharing');
      await revalidate();
    },
    [pageId, revalidate],
  );

  const remove = useCallback(
    async (conversationId: string) => {
      const response = await fetchWithAuth(`/api/ai/page-agents/${pageId}/conversations/${conversationId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete conversation');
      await revalidate();
      onDeleted(conversationId);
    },
    [pageId, revalidate, onDeleted],
  );

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <PageAgentHistoryTab
        conversations={[...(conversations ?? [])]}
        currentConversationId={currentConversationId}
        onSelectConversation={onOpen}
        onDeleteConversation={(conversationId) => void remove(conversationId).catch(reportFailure)}
        onToggleShare={(conversationId, isShared) => void toggleShare(conversationId, isShared).catch(reportFailure)}
        isLoading={isLoading}
      />
    </div>
  );
}

/** The Settings tab: the five category rows (C-Files-AiChat Settings). */
function AgentSettingsRows({ title }: { readonly title: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
      <div className="mx-auto flex w-full flex-col">
        <h2 className="m-0 mb-1 text-sm font-semibold">Agent settings</h2>
        <p className="mb-4 text-xs text-ink-muted">How {title} thinks, what it can reach, and what it can use.</p>
        <AgentSettingsMenu items={agentSettingsItems()} selectCategory={() => undefined} />
      </div>
    </div>
  );
}

/**
 * An agent page in the v3 middle (C-Files-AiChat): the Agent views strip, then the Chat, History
 * or Settings view. The tab lives in `?tab=` so a reload or a shared link keeps it. The side chat
 * and the settings sub-nav are IMC-3.11 and 3.12.
 */
export function AgentPage({ page, driveId, pageId }: PageTypeProps) {
  const [view, setViewState] = useState<AgentView>('chat');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);

  // Read the tab once the page is on the client: the server has no address bar to read from.
  useEffect(() => {
    setViewState(agentViewFrom(new URLSearchParams(window.location.search).get(TAB_PARAM)));
  }, []);

  const select = useCallback((next: AgentView) => {
    setViewState(next);
    const url = new URL(window.location.href);
    url.searchParams.set(TAB_PARAM, next);
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const startNewConversation = useCallback(() => {
    setConversationId(null);
    setChatKey((key) => key + 1);
    select('chat');
  }, [select]);

  const openConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      setChatKey((key) => key + 1);
      select('chat');
    },
    [select],
  );

  const deleted = useCallback((id: string) => {
    setConversationId((current) => (current === id ? null : current));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentViewsStrip
        title={page.title}
        driveId={driveId}
        pageId={pageId}
        view={view}
        onSelect={select}
        onNewConversation={startNewConversation}
      />
      {view === 'chat' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <RetainedChat key={chatKey} agentId={pageId} name={page.title} conversationId={conversationId} resolving={false} />
        </div>
      )}
      {view === 'history' && (
        <AgentHistory pageId={pageId} currentConversationId={conversationId} onOpen={openConversation} onDeleted={deleted} />
      )}
      {view === 'settings' && <AgentSettingsRows title={page.title} />}
    </div>
  );
}

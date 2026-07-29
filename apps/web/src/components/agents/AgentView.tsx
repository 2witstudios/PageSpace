'use client';

/**
 * AgentView — renders identically wherever an agent conversation appears.
 *
 * ```
 * AgentView (agentId, conversationId, context: 'page' | 'console')
 * ├─ header: agent title · sandbox status chip · [Add shell] · conversation
 * │          picker (page context, via `headerExtra`) / cross-link to the
 * │          agent page (console context)
 * └─ Tabs: 'chat' → SessionChat | per-shell (forceMount+hidden) → Shell
 *          | 'settings' (page context, via `settingsTab`)
 * ```
 *
 * The tab descriptors come from the pure `resolveSessionTabs(shells)` — this
 * component is the ONLY pane-aware thing here, so a future pane container can
 * consume the same descriptors with the leaves unchanged (`SessionChat`/
 * `Shell` take no layout props). `settingsTab` is deliberately NOT one of
 * those descriptors: it is a static, page-context-only tab layered on top,
 * wired by the caller (`CenterPanel`'s AI_CHAT branch) rather than derived
 * from session state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Bot, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useResolvedAgent } from './useResolvedAgent';
import { useAgentSession } from './useAgentSession';
import { useSessionShells } from './useSessionShells';
import SessionChat from './chat/SessionChat';
import Shell from './shell/Shell';
import { resolveSessionTabs, CHAT_TAB_ID } from '@/lib/agents/session-tabs';
import { describeSandboxStatus, resolveDisplayStatus } from '@/lib/agents/session-status';

const SETTINGS_TAB_ID = 'settings';

export interface AgentViewProps {
  agentId: string;
  /** ≡ the sessionId. */
  conversationId: string;
  context: 'page' | 'console';
  /** Conversation picker (page context) — the console gets its selection from the sidebar instead. */
  headerExtra?: React.ReactNode;
  /** Re-hosted settings/integrations/webhooks content — page context only. Its presence is what adds the tab. */
  settingsTab?: React.ReactNode;
  /** Read-only viewers get history but no send/edit/delete/retry/shell affordances. */
  isReadOnly?: boolean;
}

export default function AgentView({
  agentId,
  conversationId,
  context,
  headerExtra,
  settingsTab,
  isReadOnly = false,
}: AgentViewProps) {
  const { agent, isLoading: agentLoading, error: agentError, retry: retryAgent } = useResolvedAgent(agentId);
  const session = useAgentSession(conversationId);
  const shells = useSessionShells(conversationId);
  const [activeTab, setActiveTab] = useState<string>(CHAT_TAB_ID);
  const [isAddingShell, setIsAddingShell] = useState(false);

  const tabs = useMemo(() => resolveSessionTabs(shells.shells), [shells.shells]);
  const tabIds = useMemo(() => new Set(tabs.map((tab) => tab.id)), [tabs]);

  // A closed shell's tab disappears out from under whatever was showing it —
  // fall back to chat rather than rendering a Tabs.Root pointed at a value
  // with no matching trigger/content.
  useEffect(() => {
    if (activeTab === SETTINGS_TAB_ID) return;
    if (!tabIds.has(activeTab)) setActiveTab(CHAT_TAB_ID);
  }, [activeTab, tabIds]);

  const handleAddShell = useCallback(async () => {
    if (isAddingShell) return;
    setIsAddingShell(true);
    try {
      const shell = await shells.addShell();
      if (shell) setActiveTab(`shell:${shell.shellId}`);
    } finally {
      setIsAddingShell(false);
    }
  }, [isAddingShell, shells]);

  const handleCloseShell = useCallback(
    async (shellId: string) => {
      await shells.removeShell(shellId);
    },
    [shells],
  );

  if (agentLoading) {
    return (
      <div data-testid="agent-view-loading" className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Loading has FINISHED and there is still no agent. Distinguishing this from
  // the spinner above matters: SWR stops retrying after a genuine failure, so a
  // combined `agentLoading || !agent` guard left the user watching a spinner
  // that would never resolve, with no error text and no way out but a reload.
  if (!agent) {
    return (
      <div
        data-testid="agent-view-error"
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
    );
  }

  // Adding the first shell is what actually provisions the sandbox (there is no
  // explicit "start" affordance — provisioning is lazy by design), so it is the
  // one moment a user watches a cold Sprite boot. Without folding it in, the
  // chip reads "No sandbox yet. One starts the first time the agent needs to run
  // something." for that entire wait — the one moment that sentence is false.
  const statusCopy = describeSandboxStatus(
    resolveDisplayStatus({ status: session.status, isProvisioning: isAddingShell }),
  );

  return (
    <div data-testid="agent-view" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.title}</span>
        <span
          data-testid="sandbox-status-chip"
          title={statusCopy.description}
          // The description was reachable only by hovering for a tooltip —
          // invisible to a screen reader and to anyone not using a mouse.
          aria-label={`Sandbox: ${statusCopy.label}. ${statusCopy.description}`}
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
        >
          {statusCopy.label}
        </span>
        {context === 'page' ? (
          headerExtra
        ) : (
          <Link
            href={`/dashboard/${encodeURIComponent(agent.driveId)}/${encodeURIComponent(agentId)}`}
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Open agent page
          </Link>
        )}
        {!isReadOnly && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => void handleAddShell()}
            disabled={isAddingShell}
          >
            <Plus className="size-3.5" />
            {isAddingShell ? 'Adding…' : 'Add shell'}
          </Button>
        )}
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="shrink-0 justify-start rounded-none border-b border-border bg-transparent p-0">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              data-testid={`tab-trigger-${tab.id}`}
              className="gap-1.5 rounded-none"
            >
              {tab.label}
              {tab.kind === 'shell' && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.label}`}
                  className="ml-1 rounded-sm p-0.5 hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCloseShell(tab.shellId);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.stopPropagation();
                    event.preventDefault();
                    void handleCloseShell(tab.shellId);
                  }}
                >
                  <X className="size-3" />
                </span>
              )}
            </TabsTrigger>
          ))}
          {settingsTab && (
            <TabsTrigger value={SETTINGS_TAB_ID} className="rounded-none">
              Settings
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value={CHAT_TAB_ID} className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <SessionChat agent={agent} conversationId={conversationId} context={context} isReadOnly={isReadOnly} />
        </TabsContent>

        {tabs
          .filter((tab) => tab.kind === 'shell')
          .map((tab) => (
            <TabsContent
              key={tab.id}
              value={tab.id}
              forceMount
              className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
            >
              <Shell shellId={tab.shellId} name={tab.label} />
            </TabsContent>
          ))}

        {settingsTab && (
          <TabsContent value={SETTINGS_TAB_ID} className="mt-0 min-h-0 flex-1 overflow-auto">
            {settingsTab}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

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
import { useSearchParams } from 'next/navigation';
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
import { toast } from 'sonner';
import { mutate } from 'swr';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  PageAgentSettingsTab,
  PageAgentHistoryTab,
  type PageAgentSettingsTabRef,
} from '@/components/ai/page-agents';
import { PageWebhooksDialog } from '@/components/shared/PageWebhooksDialog';
import { useProviderSettings } from '@/lib/ai/shared/hooks/useProviderSettings';
import { useConversations } from '@/lib/ai/shared/hooks/useConversations';
import { useAgentConfig } from '@/lib/ai/shared/hooks/useAgentConfig';
import { buildAgentSelectionUrl } from '@/lib/agents/agent-selection';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAuth } from '@/hooks/useAuth';
import { useLatestRef } from '@/hooks/useLatestRef';
import { usePermissionsCheck } from './usePermissionsCheck';
import {
  useResolvedConversation,
  createPageConversation,
  type ResolvedConversation,
} from './useResolvedConversation';
import { useResolvedAgent } from './useResolvedAgent';
import { useSessionRecord } from './useSessionRecord';
import SessionChat from './chat/SessionChat';
import AgentPanes from './panes/AgentPanes';
import { agentSessionsKey, isAgentSessionsKey, type SessionListEntry } from './panes/session-conversations';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { TreePage } from '@/hooks/usePageTree';

export interface AgentPageViewProps {
  page: TreePage;
}

export default function AgentPageView({ page }: AgentPageViewProps) {
  const { user, isLoading: authLoading } = useAuth();
  // The same gate every session surface uses — the server still decides
  // (drive membership + code-execution) on every spawn.
  const canUseSessions = user?.role === 'admin';

  // A deep link from the Agents surface's past-conversations list
  // (`?conversationId=&sessionId=`) — one-time intent, not durable state like
  // the Agents surface's own `?session=`/`?c=`/`?agent=`, so it's captured
  // once at mount and never re-read afterward (a later History-tab pick or
  // "new conversation" is not fighting a stale URL param).
  const searchParams = useSearchParams();
  const initialConversationIdRef = useRef(searchParams.get('conversationId') ?? undefined);
  const initialSessionIdRef = useRef(searchParams.get('sessionId'));

  // Consume-once, for real: strip the params from the URL immediately after
  // capturing them. Left in place, a refresh after the user later switches
  // to a DIFFERENT conversation (History tab, "new") would remount this
  // component, re-read the same stale `conversationId` from the URL, and
  // silently reopen the original deep-linked thread instead of respecting
  // where the user actually navigated to (review finding — this was
  // previously dismissed as "cosmetic", but it's a real functional bug on
  // refresh, not just an untidy address bar).
  useEffect(() => {
    if (initialConversationIdRef.current === undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('conversationId');
    url.searchParams.delete('sessionId');
    window.history.replaceState({}, '', url.toString());
    // Deliberately empty deps: this runs once, immediately after the refs
    // above captured their values on this same mount — never re-runs for
    // this component instance.
  }, []);

  const { resolved: initialResolved } = useResolvedConversation(page.id, {
    driveId: page.driveId,
    canUseSessions,
    // A hard refresh starts `user` (and so `canUseSessions`) undefined/false
    // before the role loads — resolving then would mint the agent's first
    // conversation as permanently session-less. Wait it out.
    authLoading,
    initialConversationId: initialConversationIdRef.current,
    initialSessionId: initialSessionIdRef.current,
  });
  const [override, setOverride] = useState<ResolvedConversation | null>(null);
  // The conversation on screen: the user's own switching (history select, new,
  // delete-replacement) wins over the initial resolution.
  const current = override ?? initialResolved;

  // The SESSION's own driveId — usually `page.driveId`, but NOT when this
  // conversation lives in a global-assistant session hosting a cross-drive
  // agent (a global session may now host any accessible agent's conversation;
  // see create-conversation-in-session.ts). `AgentPanes` needs the SESSION's
  // real drive (null for global), never the agent page's fixed home drive, or
  // its `agentSessionsKey`/picker scope to a workspace this session isn't in.
  // Defaults to `page.driveId` while unresolved — correct for every
  // pre-existing conversation, and self-corrects once the session record
  // loads for the new cross-drive case. Checked as `sessionData?.session ? : `
  // rather than `??` — a RESOLVED session's `driveId` can itself legitimately
  // be `null` (a global session), which `??` would wrongly treat the same as
  // "unresolved" and fall through to `page.driveId`.
  const { data: sessionData } = useSessionRecord(current?.sessionId ?? null);
  const panesDriveId = sessionData?.session ? sessionData.session.driveId : page.driveId;

  // `?tab=` deep-links here (the agents console's per-pane Settings link, via
  // `/p/[pageId]`, which forwards the query string verbatim). Seeded once at
  // mount (a lazy initializer, so a fresh navigation lands on the right tab
  // with no flash of "chat" first) AND re-synced by the effect below on every
  // subsequent `searchParams` change: clicking that link while THIS SAME
  // `AgentPageView` instance is already mounted — its own Chat tab hosts a
  // pane for its own agent, so the pane bar's Settings link can point right
  // back at the page it's already showing — is a query-only navigation Next
  // does not remount for, so a mount-only read would silently no-op (review
  // finding — chatgpt-codex-connector on PR #2296).
  const [activeTab, setActiveTab] = useState<string>(() => {
    const tab = searchParams.get('tab');
    return tab === 'history' || tab === 'settings' ? tab : 'chat';
  });

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab !== 'history' && tab !== 'settings') return;
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.delete('tab');
    window.history.replaceState({}, '', url.toString());
  }, [searchParams]);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  // SWR-backed and keyed by `page.id` — shared with every pane showing this
  // agent's Settings tab (see `useAgentConfig`'s own doc), not a private
  // per-instance fetch.
  const { config: agentConfig, setConfig: setAgentConfig, revalidate: revalidateAgentConfig } = useAgentConfig(page.id);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);

  const isReadOnly = usePermissionsCheck(page.id, user?.id);

  const { agent, isLoading: agentLoading, error: agentError, retry: retryAgent } = useResolvedAgent(page.id);

  const {
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings({ pageId: page.id });

  const newConversation = useCallback(
    async (reuseSessionId?: string | null, options?: { applyOverride?: boolean }) => {
      const created = await createPageConversation({
        agentId: page.id,
        driveId: page.driveId,
        canUseSessions,
        sessionId: reuseSessionId ?? null,
      });
      // Every OTHER caller (History's "New" button, the session-ended
      // fallback) wants this mint to become the visible conversation
      // unconditionally, which is why this defaults to true — only
      // `mintReplacementForCurrent` below opts out, because by the time its
      // own await resolves the user may have already moved on to something
      // else and an unconditional override would clobber that pick.
      if (options?.applyOverride ?? true) {
        setOverride(created);
        setActiveTab('chat');
      }
      return created;
    },
    [page.id, page.driveId, canUseSessions],
  );

  // The LATEST `current`, read at completion time rather than trusted from a
  // closure captured before an await — `mintReplacementForCurrent` runs after
  // an async gap (a conversation-close DELETE, or `deleteConversation`), and
  // the user can select a different thread while that request is in flight.
  // Without this, a slow request's callback still holds the OLD `current` it
  // closed over, wrongly matches the just-closed id, and overwrites the
  // user's newer selection with an unwanted replacement (caught in review).
  const currentRef = useLatestRef(current);

  // Shared by the History-tab delete AND a session-grid listing close: both
  // leave `current` pointing at a conversation that is no longer usable here,
  // and both recover the SAME way — mint this agent's replacement INTO the
  // same session (never spawn a new one, which would abandon a live session —
  // issue #2263, finding 4) and prune the pane that was showing the old id,
  // wherever it lives in the grid (not necessarily the active pane: the
  // grid's own selection and this page's `current` are independent state).
  const mintReplacementForCurrent = useCallback(
    (deletedConversationId: string) => {
      // `deletedConversationId` is the ACTUAL id the caller confirmed is gone
      // (from `useConversations`, matched against `currentConversationId` at
      // CLICK time) — not necessarily what `current` still is NOW. If the
      // user already switched to a different thread while this delete was
      // in flight, `current` no longer names the deleted conversation, and
      // minting a replacement (into whatever session `current` now belongs
      // to) would wrongly repoint that OTHER conversation's pane instead
      // (caught in review). Bail rather than guess.
      if (currentRef.current?.conversationId !== deletedConversationId) return;
      const staleConversationId = deletedConversationId;
      const sessionId = currentRef.current?.sessionId ?? null;
      void (async () => {
        try {
          // `applyOverride: false` — this mint has its OWN async gap (the POST
          // below), and the user can select a different thread while it's in
          // flight. Applying `newConversation`'s default unconditional override
          // after that gap would silently replace whatever they picked in the
          // meantime (caught in review) — checked explicitly below instead.
          const created = await newConversation(sessionId, { applyOverride: false });
          // A background revalidate alone leaves a real window: if the user
          // closes the replacement pane before that GET resolves (or it
          // fails), `AgentPanes`' own cache still lacks this brand-new row,
          // reads it as absent, and can even offer to end the session on a
          // grid whose only cached listing is now stale (caught in review —
          // the earlier revalidate-only fix here missed the same optimistic
          // LOCAL insert `handlePickAgent` already does via
          // `recordMintedConversation` before it ever revalidates).
          if (created.sessionId) {
            const insertedSessionId = created.sessionId;
            // A REUSED session (sessionId set) keeps its own drive — which for
            // a global session hosting this cross-drive agent's conversation
            // is NOT `page.driveId` — while a freshly SPAWNED one (sessionId
            // null going in) is always minted scoped to this page's own drive
            // (`createPageConversation`'s spawn branch). Using `page.driveId`
            // unconditionally here silently patched the wrong SWR cache entry
            // for the reused-global case (`agentSessionsKey`'s own doc
            // comment warns against exactly this drift) — the broader
            // `mutate(isAgentSessionsKey)` below still catches it, just not
            // instantly.
            void mutate(
              agentSessionsKey(sessionId !== null ? panesDriveId : page.driveId),
              (current: { sessions: SessionListEntry[] } | undefined) => {
                if (!current) return current;
                return {
                  sessions: current.sessions.map((session) =>
                    session.sessionId === insertedSessionId
                      ? {
                          ...session,
                          conversations: [
                            { conversationId: created.conversationId, agentPageId: page.id, lastMessageAt: null },
                            ...session.conversations,
                          ],
                        }
                      : session,
                  ),
                };
              },
              { revalidate: false },
            );
          }
          // ...and a broader revalidate for every OTHER `/api/agent-sessions**`
          // consumer (the sidebar, other panes) whose differently-scoped
          // cache key the local insert above doesn't touch.
          void mutate(isAgentSessionsKey);
          if (sessionId && staleConversationId) {
            // The grid's pane binding is repointed regardless: a pane still
            // showing the now-gone `staleConversationId` is a dangling reference
            // no matter what this page's OWN `current` has moved on to.
            useAgentWorkspaceStore.getState().replaceConversation(sessionId, staleConversationId, {
              kind: 'chat',
              name: 'New conversation',
              targetId: created.conversationId,
              agentPageId: page.id,
            });
          }
          // Only follow the replacement as THIS page's own view if the user
          // hasn't already navigated elsewhere while the mint was in flight.
          // Uses `created.sessionId`, not the outer `sessionId` — a session-less
          // stale conversation (sessionId null) can still mint INTO a fresh
          // session when `canUseSessions` is true, and this must reflect that
          // real result, not the pre-mint guess (caught in adversarial review).
          if (currentRef.current?.conversationId === staleConversationId) {
            setOverride({ conversationId: created.conversationId, sessionId: created.sessionId });
            setActiveTab('chat');
          }
        } catch (error) {
          // The listing close already succeeded server-side by the time this
          // runs — only the REPLACEMENT mint failed (network, lost
          // permission, a concurrent cap fill). Without a catch here this was
          // an unhandled rejection, and `current` was left silently pointing
          // at a conversation that no longer exists with no replacement pane
          // (caught in review). Report it; no further recovery is attempted
          // here, same as every other failed-IO catch in this file's siblings.
          console.error('Failed to create a replacement conversation:', error);
          toast.error('Could not start a replacement conversation', {
            description: error instanceof Error ? error.message : 'Please try again.',
          });
        }
      })();
    },
    [newConversation, page.id, page.driveId, panesDriveId, currentRef],
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
    // `onConversationDelete` only fires for the CURRENT conversation, so
    // `current` here is exactly the deleted thread.
    onConversationDelete: mintReplacementForCurrent,
  });

  // The session grid closed `current`'s listing (its last pane, in a pane
  // this page-view tab wasn't itself driving — e.g. a split the user made).
  // Closing a listing never mints a replacement on its own (it isn't a
  // history delete), but THIS tab needs `current` to keep naming a usable
  // conversation for its agent, so it recovers the same way History-delete
  // does: mint a fresh one for this agent into the same session — UNLESS the
  // grid already rebound to another OPEN listing that belongs to this same
  // agent, in which case following it is free and avoids leaving a redundant
  // empty conversation behind (caught in review: this host was the one place
  // that always minted instead of following `next` like AgentsSurface does).
  const handleConversationClosed = useCallback(
    (event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => {
      if (event.conversationId !== currentRef.current?.conversationId) return;
      if (event.next !== null && event.nextAgentPageId === page.id) {
        setOverride({ conversationId: event.next, sessionId: currentRef.current?.sessionId ?? null });
        setActiveTab('chat');
        return;
      }
      mintReplacementForCurrent(event.conversationId);
    },
    [mintReplacementForCurrent, currentRef, page.id],
  );

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
        // The SESSION's own drive, not the hosted page's — for a global
        // session hosting this cross-drive agent's conversation, that
        // session only appears in the GLOBAL console (`/dashboard/agents`),
        // not a drive-scoped one; `page.driveId` here would build a link to
        // a console that self-corrects late (or, for the console's own
        // pre-existing null/undefined-conflating fallback, not at all).
        driveId: panesDriveId,
        sessionId: current?.sessionId ?? null,
        agentId: page.id,
        conversationId: current?.conversationId ?? null,
      }),
    [panesDriveId, page.id, current],
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
              driveId={panesDriveId}
              initialConversation={{
                conversationId: current.conversationId,
                agentPageId: page.id,
                name: 'Conversation',
              }}
              chatContext="page"
              hostConversationId={current.conversationId}
              isReadOnly={isReadOnly}
              onSessionEnded={() => void handleCreateNew()}
              onConversationClosed={handleConversationClosed}
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
              sessionId={null}
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
            onConfigRevalidate={revalidateAgentConfig}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onProviderChange={setSelectedProvider}
            onModelChange={setSelectedModel}
            isProviderConfigured={isProviderConfigured}
            onSavingChange={setIsSettingsSaving}
          />
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

'use client';

/**
 * AgentPageView — the drive AI_CHAT page.
 *
 * **This page has no chrome of its own.** It used to wear a `p-4` header with
 * Chat | History | Settings as text pills, a Save button, a webhooks button and
 * an "Open in Agents" link — and then mount the pane grid inside its own Chat
 * tab, where the host pane's bar carried a SECOND Chat/History/Settings strip
 * for the very same conversation. Two tab sets, one conversation. The header is
 * gone; the pane bar is the only bar. Its former occupants moved to where they
 * belong: webhooks into the agent's own Settings → Integrations, "Open in
 * Agents" into the pane bar beside the pane's other controls, Save into the
 * pane bar it already existed in.
 *
 * That leaves this component as a resolver, not a layout: it decides WHICH chat
 * surface a conversation gets, and owns the conversation-replacement plumbing
 * (mint, delete, close) that both surfaces share.
 *
 * A conversation born into a session renders `AgentPanes` — split-capable,
 * every pane sharing the session's ONE sandbox by construction, every pane
 * wearing its own bar. Everyone else gets the plain chat, which wears the SAME
 * bar with no grid behind it — tab strip included, so History and Settings are
 * reachable there too. Binding is set at creation and permanent, so a
 * pre-session conversation (sessionId null) cannot join a workspace (that would
 * be a rebind; the model's escape hatch is forking, later) — which is why the
 * plain branch is not a degraded fallback but a permanent home for most of
 * history.
 *
 * There is NO sandbox chrome here: no status chip, no Add-shell. Provisioning
 * is lazy and automatic (first tool call / shell open), and shells live in
 * panes, opened from the pane picker like everywhere else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { mutate } from 'swr';
import { Button } from '@/components/ui/button';
import {
  PageAgentSettingsTab,
  PageAgentHistoryTab,
  type PageAgentSettingsTabRef,
} from '@/components/ai/page-agents';
import { useProviderSettings } from '@/lib/ai/shared/hooks/useProviderSettings';
import { useAgentSettingsSaveState } from '@/lib/ai/shared/hooks/useAgentSettingsSaveState';
import { useConversations } from '@/lib/ai/shared/hooks/useConversations';
import { useAgentConfig } from '@/lib/ai/shared/hooks/useAgentConfig';
import { buildAgentSelectionUrl } from '@/lib/agents/agent-selection';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAuth } from '@/hooks/useAuth';
import { useLatestRef } from '@/hooks/useLatestRef';
import { useConversationActiveStream } from '@/hooks/useActiveStream';
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
import PaneBar, {
  PaneChatTabStrip,
  PaneNewConversationAction,
  PaneOpenInAgentsAction,
  PaneSettingsSaveAction,
  PaneSessionIdentity,
  type PaneChatTab,
} from './panes/PaneBar';
import { agentWorkspacesKey, isAgentWorkspacesKey, type SessionListEntry } from './panes/workspace-conversations';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { TreePage } from '@/hooks/usePageTree';

export interface AgentPageViewProps {
  page: TreePage;
}

export default function AgentPageView({ page }: AgentPageViewProps) {
  const { user, isLoading: authLoading } = useAuth();
  // Sessions/chat/panes are open to every authenticated user — the sandbox
  // itself (real cloud compute) is what's tier-gated, server-side, on every
  // spawn/tool-call. `!authLoading` matters because `useAuthStore` PERSISTS
  // `user`: a stale hydrated row would otherwise enable the pane grid and its
  // session actions before /api/auth/me has confirmed (or rejected) the
  // session — wait out the resolution window instead (review #2326).
  //
  // But that window closes ONCE, and it must not reopen: `loadSession()` sets
  // `isLoading: true` again on its routine recheck (every AUTH_CHECK_INTERVAL,
  // 15 minutes — useAuthStore.ts). Recomputing `!authLoading` each time would
  // drop `canUseSessions`, unmount `AgentPanes` mid-session, and destroy any
  // unsaved Settings draft living in a pane — which is new damage now that the
  // page has no Settings tab of its own to survive the flip. So the
  // confirmation LATCHES, and only a signed-out `user` clears it.
  const authConfirmedRef = useRef(false);
  if (!user) authConfirmedRef.current = false;
  else if (!authLoading) authConfirmedRef.current = true;
  const canUseSessions = Boolean(user) && authConfirmedRef.current;

  // A deep link from the Agents surface's past-conversations list
  // (`?conversationId=&sessionId=`) — one-time intent, not durable state like
  // the Agents surface's own `?workspace=`/`?c=`/`?agent=`, so it's captured
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
  // see create-conversation-in-workspace.ts). `AgentPanes` needs the SESSION's
  // real drive (null for global), never the agent page's fixed home drive, or
  // its `agentWorkspacesKey`/picker scope to a workspace this session isn't in.
  // Defaults to `page.driveId` while unresolved — correct for every
  // pre-existing conversation, and self-corrects once the session record
  // loads for the new cross-drive case. Checked as `sessionData?.session ? : `
  // rather than `??` — a RESOLVED session's `driveId` can itself legitimately
  // be `null` (a global session), which `??` would wrongly treat the same as
  // "unresolved" and fall through to `page.driveId`.
  const { data: sessionData } = useSessionRecord(current?.sessionId ?? null);
  const panesDriveId = sessionData?.session ? sessionData.session.driveId : page.driveId;

  // Chat | History | Settings for the SESSION-LESS branch only. A session-bound
  // conversation renders the pane grid, and every pane there carries its own
  // copy of this strip in its own bar — which is why this page no longer has a
  // header of its own: two tab sets addressing the same conversation was the
  // duplicate chrome this state used to feed.
  const [activeTab, setActiveTab] = useState<PaneChatTab>('chat');
  // SWR-backed and keyed by `page.id` — shared with every pane showing this
  // agent's Settings tab (see `useAgentConfig`'s own doc), not a private
  // per-instance fetch.
  const { config: agentConfig, setConfig: setAgentConfig, revalidate: revalidateAgentConfig } = useAgentConfig(page.id);
  // `isConfigLoaded` matters because the Settings tab registers `submitForm`
  // before its own config-loaded check returns, and its form defaults contain
  // an EMPTY prompt/tool list — so Save must stay inert until real config has
  // loaded and been edited. Same guard AgentPanes passes for the same reason.
  const {
    saveState: settingsSaveState,
    setIsSaving: setIsSettingsSaving,
    setIsDirty: setIsSettingsDirty,
    handleSaved: handleSettingsSaved,
  } = useAgentSettingsSaveState({ isConfigLoaded: agentConfig !== null });
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
  /**
   * Tell every `/api/agent-workspaces**` reader about a conversation that was
   * just minted INTO a session, before any GET confirms it.
   *
   * A background revalidate alone leaves a real window: a consumer reading the
   * still-stale listing sees the brand-new row as absent — `AgentPanes` can
   * even offer to end the session on a grid whose only cached listing no longer
   * matches. Extracted so the page's "+" gets the same treatment the
   * delete-replacement mint already had; before this, only one of the two
   * session-reusing mints on this page kept the listing honest.
   */
  const recordMintedIntoSession = useCallback(
    (created: ResolvedConversation, reusedSessionId: string | null) => {
      if (created.sessionId) {
        const insertedSessionId = created.sessionId;
        // A REUSED session (id set going in) keeps its own drive — which for a
        // global session hosting this cross-drive agent's conversation is NOT
        // `page.driveId` — while a freshly SPAWNED one is always minted scoped
        // to this page's own drive (`createPageConversation`'s spawn branch).
        // Using `page.driveId` unconditionally patches the wrong SWR cache
        // entry for the reused-global case.
        void mutate(
          agentWorkspacesKey(reusedSessionId !== null ? panesDriveId : page.driveId),
          (cached: { sessions: SessionListEntry[] } | undefined) => {
            if (!cached) return cached;
            return {
              sessions: cached.sessions.map((session) =>
                session.workspaceId === insertedSessionId
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
      // ...and a broader revalidate for every OTHER `/api/agent-workspaces**`
      // consumer (the sidebar, other panes) whose differently-scoped cache key
      // the local insert above doesn't touch.
      void mutate(isAgentWorkspacesKey);
    },
    [panesDriveId, page.driveId, page.id],
  );

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
          recordMintedIntoSession(created, sessionId);
          if (sessionId && staleConversationId) {
            // The grid's pane binding is repointed regardless: a pane still
            // showing the now-gone `staleConversationId` is a dangling reference
            // no matter what this page's OWN `current` has moved on to.
            // The node showing the now-gone conversation is a dangling
            // reference whatever this page's own `current` has moved on to.
            //
            // Addressed as a PLACEMENT, not as a rebind. A binding is for life,
            // so the fresh conversation cannot be pointed at the stale node; it
            // gets a node of its own in that slot, and the stale one KEEPS ITS
            // OWN — still in the tree, still a member, still on screen — which
            // is strictly better than the pane it used to overwrite in place.
            // `activeNodeId` is how "here, in this rectangle" is said to the
            // placement policy.
            const workspaceNodes =
              useAgentWorkspaceStore.getState().workspaces[sessionId]?.nodes ?? [];
            const staleNode = workspaceNodes.find(
              (node) =>
                node.nodeType === 'pane' &&
                node.target?.kind === 'chat' &&
                node.target.id === staleConversationId,
            );
            if (staleNode) {
              useAgentWorkspaceStore
                .getState()
                .openConversation(sessionId, created.conversationId, { activeNodeId: staleNode.id });
            }
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
    [newConversation, page.id, page.driveId, panesDriveId, currentRef, recordMintedIntoSession],
  );

  const {
    conversations,
    isLoading: isLoadingConversations,
    deleteConversation,
    refreshConversations,
  } = useConversations({
    agentId: page.id,
    currentConversationId: current?.conversationId ?? null,
    // Only while History is actually showing. `activeTab` is the SESSION-LESS
    // branch's state, and that branch's History is the one place this list is
    // read (`handleSelectConversation` looks a pick up for its session, and it
    // is only callable from there). The grid branch keeps `activeTab` on
    // 'chat' forever, so the old `|| activeTab === 'chat'` fetched an agent's
    // whole conversation list on every session-bound page load for nobody.
    enabled: activeTab === 'history',
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

  // Mid-stream, "+" is refused here for the same reason the grid refuses it
  // (AgentPanes' `blockedByActiveStream`): replacing what is showing would yank
  // a still-arriving response, and any in-flight tool work, out from under
  // itself with no way back. The grid had this guard and the page did not,
  // which is exactly the kind of same-control-different-behaviour split this
  // change exists to remove. `page.id` is the channel an agent's own stream is
  // tagged with — this surface has no Assistant case to fall back to.
  const activeStream = useConversationActiveStream(page.id, current?.conversationId ?? null);
  const blockedByActiveStream = activeStream !== undefined;

  // In-flight guard. `newConversation` mints server-side with no idempotency
  // key, so two clicks are two conversations — and the "+" this now feeds sits
  // permanently beside the chat, where a double-click is ordinary, rather than
  // behind the History tab where it used to be the only way in. A ref, not
  // state, is what the guard READS: two clicks in the same tick would both see
  // a stale `false` from state. State exists alongside it purely to disable the
  // button, which is feedback, not the guard. A COUNTER rather than a boolean,
  // so an `isRecovery` caller (below) overlapping a user click cannot clear the
  // flag out from under the one still running.
  const inFlightRef = useRef(0);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateNew = useCallback(async (options?: {
    /**
     * Mint INTO this session rather than spawning or going plain. Set by the
     * page's own "+", which can be showing a session-BOUND conversation: the
     * plain branch is reached whenever `canUseSessions` is momentarily false,
     * and it does go false after mount — `useAuthStore.loadSession()` sets
     * `isLoading` on every routine background recheck of an already-signed-in
     * session (see Layout.tsx's own note on exactly that). Minting without the
     * id there would hand the user a permanently session-less replacement and
     * abandon a live workspace, which is precisely what
     * `mintReplacementForCurrent` passes its own session id to prevent.
     */
    reuseSessionId?: string | null;
    /**
     * Not a user click — a recovery mint, which bypasses BOTH refusals below.
     * The in-flight guard exists to dedupe one user intent, not to make the
     * session-ended recovery a no-op because History's button happened to be
     * mid-round-trip; and the stream guard protects a response still arriving,
     * which by definition is not the case once the session that was producing
     * it has ended. Refusing here would strand the user on a conversation
     * whose session is gone.
     */
    isRecovery?: boolean;
  }) => {
    if (inFlightRef.current > 0 && !options?.isRecovery) return;
    if (blockedByActiveStream && !options?.isRecovery) return;
    inFlightRef.current += 1;
    setIsCreating(true);
    try {
      const created = await newConversation(options?.reuseSessionId ?? null);
      // Same optimistic listing insert the delete-replacement mint does — a
      // conversation minted into a live session must not be invisible to the
      // grid that is about to mount against a cached listing.
      recordMintedIntoSession(created, options?.reuseSessionId ?? null);
      // Live only for History's own "New" (the hook is enabled while that tab
      // is showing); from the bar's "+" the hook is disabled and this is a
      // no-op, which is correct — a list nothing is rendering needs no refresh,
      // and SWR revalidates when History next mounts the key.
      refreshConversations();
    } catch (error) {
      // Every caller fires this as `void handleCreateNew()`, so a rejection
      // escaping here is an unhandled rejection and the user is told nothing —
      // the button simply appears not to work. Say it, in the same words
      // `useResolvedConversation` uses when its own create fails.
      console.error('Failed to create agent conversation:', error);
      toast.error('Could not start a new conversation', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      inFlightRef.current -= 1;
      setIsCreating(inFlightRef.current > 0);
    }
  }, [newConversation, refreshConversations, blockedByActiveStream, recordMintedIntoSession]);

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
    <div data-testid="agent-page-view" className="flex h-full min-h-0 flex-col">
      {/* No page header, and no page-level tabs. Every chat surface here wears
          exactly ONE bar — the pane bar — carrying its own Chat/History/Settings
          strip, its own Save, and its own cross-link to the console. The page
          used to stack a second, full-size copy of those tabs above the grid,
          addressing the same conversation the host pane's bar already did. */}
      {current.sessionId && canUseSessions ? (
        // `AgentPanes` renders a fragment and `SessionPanes` sizes itself
        // `h-full`, so the flex context is the CALLER's job — the removed
        // `TabsContent` used to supply it, and the agents console wraps it the
        // same way. Without this the grid has no height to resolve against.
        <div className="flex min-h-0 flex-1 flex-col">
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
            onSessionEnded={() => void handleCreateNew({ isRecovery: true })}
            onConversationClosed={handleConversationClosed}
          />
        </div>
      ) : agentLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        // A session-less conversation gets no pane GRID — but it wears the
        // same bar the grid's panes do, tab strip included. Binding is
        // congenital and permanent (see useResolvedConversation), so which
        // branch the user lands on is a property of the conversation they
        // cannot see; without the strip here, History and Settings would be
        // reachable for a session-bound conversation and unreachable for every
        // older one. `group/pane` so the bar's actions reveal on hover exactly
        // as they do in the grid.
        <div className="group/pane flex min-h-0 flex-1 flex-col">
          <PaneBar
            // No sibling panes here, so there is no focus state to indicate.
            isActive={false}
            identity={
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {/* The dot reports the CONVERSATION's binding, not this branch's.
                    Almost always null here — that is what put us in this branch —
                    but the branch is also where a bound conversation lands when
                    `canUseSessions` is false, and a hardcoded `false` would then
                    state something untrue about it. */}
                <PaneSessionIdentity name={agent?.title ?? page.title} bound={current.sessionId !== null} />
                <PaneChatTabStrip
                  activeTab={activeTab}
                  onSelectTab={setActiveTab}
                  // Always: this page IS an agent page, so Settings always
                  // applies — unlike a grid pane, which can be showing the
                  // Assistant. It applies even when the agent record failed to
                  // load, since Settings is keyed by `page`, not by `agent`.
                  showSettings
                  agentTitle={agent?.title ?? page.title}
                />
              </div>
            }
            actions={
              <>
                {activeTab === 'settings' && (
                  <PaneSettingsSaveAction
                    saveState={settingsSaveState}
                    onSave={() => agentSettingsRef.current?.submitForm()}
                  />
                )}
                {/* Hidden from a signed-out visitor for the same reason it always
                    was: the console would refuse them. */}
                {canUseSessions && <PaneOpenInAgentsAction href={openInAgentsHref} />}
                {/* Disabled only while a mint is in flight. Deliberately NOT
                    gated on `isReadOnly`, which here means "can view, cannot
                    edit": the create route gates on `canPrincipalViewPage`
                    (api/ai/page-agents/[agentId]/conversations/route.ts), so a
                    viewer starting their OWN conversation with someone else's
                    agent is a supported act, not one the server will refuse.
                    The History tab's button is ungated for the same reason. */}
                <PaneNewConversationAction
                  disabled={isCreating || blockedByActiveStream}
                  onCreate={() => void handleCreateNew({ reuseSessionId: current.sessionId })}
                />
              </>
            }
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'chat' ? (
              agent ? (
                <SessionChat
                  sessionId={null}
                  agent={agent}
                  conversationId={current.conversationId}
                  context="page"
                  isReadOnly={isReadOnly}
                />
              ) : (
                // Loading FINISHED and there is still no agent — SWR stops
                // retrying after a genuine failure, so a combined guard would
                // leave the user watching a spinner that never resolves.
                //
                // The error replaces the CHAT BODY only; the bar above it
                // stays, so History and Settings are still REACHABLE — and a
                // broken agent is precisely when a user wants to reach them.
                // Settings is keyed by `page`, not by the agent record that
                // failed here, and its config comes from a separate fetch
                // (`useAgentConfig`), so it renders whenever that fetch
                // succeeds; if it failed too, the settings tab shows its own
                // loading state rather than this error. Before the page header
                // was removed, its tabs gave this for free — losing it would
                // have been a real regression, not a cosmetic one.
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
              )
            ) : activeTab === 'history' ? (
              <PageAgentHistoryTab
                conversations={conversations}
                currentConversationId={current.conversationId}
                onSelectConversation={handleSelectConversation}
                // Deliberately NO `reuseSessionId`: History's "New" spawns a
                // fresh session, and that is a decision, not an oversight — #2263
                // (point 4) made the DELETE-replacement reuse the session while
                // leaving this button alone, and a test pins it by name. An
                // explicit "new conversation" from the history list is read as
                // asking to leave, where the "+" over a conversation you are
                // already in is not. (The grid's own History button reuses, so the
                // two surfaces do differ — worth settling deliberately, not by a
                // silent change here.)
                onCreateNew={() => void handleCreateNew()}
                // The shared handler's refusals, made visible: this button used to
                // stay enabled while that handler silently returned.
                createDisabled={isCreating || blockedByActiveStream}
                onDeleteConversation={(id) => void deleteConversation(id)}
                onToggleShare={toggleConversationShare}
                isLoading={isLoadingConversations}
              />
            ) : (
              <div className="h-full overflow-auto">
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
                  onDirtyChange={setIsSettingsDirty}
                  onSaved={handleSettingsSaved}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * AgentPanes — the container that turns the pure pane pieces into a working
 * grid for ONE session.
 *
 * Composition per pane, via `resolvePaneSurface`:
 *
 * ```
 * SessionPanes (layout only, surfaces injected)
 *  └─ pane: PaneBar (identity + split/close) over
 *      picker   → PanePicker      (unbound — choose an agent, a shell, or
 *                                  reattach one already running)
 *      chat     → PaneChat        (a conversation IN this session)
 *      terminal → Shell           (a PTY on this session's sandbox)
 *      loading  → spinner         (bound, row not minted yet — never a
 *                                  speculative terminal)
 * ```
 *
 * The container owns ALL the IO a pick triggers — minting a conversation into
 * THIS session, opening or reattaching a shell on THIS session — and writes
 * the resulting `PaneScope` back through `assignPane`. Sandbox identity is
 * never threaded anywhere: every conversation and shell here resolves the
 * session's one sandbox by construction (the Sprite key folds the session
 * id).
 *
 * Closing the LAST pane ends the session — confirmed, server-first, and
 * rollback-safe (issue #2263, finding 1): the grid never drops locally until
 * the DELETE succeeds, so a failure (a lost capability, a network blip)
 * leaves the user exactly where they were, on the live session, instead of
 * minting a second one behind their back. The confirm dialog is the same one
 * the sidebar's identical "End session" act already required (finding 2).
 * Closing a TERMINAL pane also kills its shell (finding 3) — a closed tab is
 * a DELETE, not an orphan — and the picker offers to reattach any shell this
 * session already has that isn't currently shown anywhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { History, Loader2, MessageSquare, Save, Settings } from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { mutate } from 'swr';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { fetchWithAuth, post, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { panesOf, type PaneState } from '@/stores/agent-workspace/pane-reducer';
import { usePageAgents } from '@/hooks/page-agents/usePageAgents';
import { useAuth } from '@/hooks/useAuth';
import { useConversationActiveStream } from '@/hooks/useActiveStream';
import { AISelector } from '@/components/ai/shared';
import { useConversations } from '@/lib/ai/shared/hooks/useConversations';
import { useAgentConfig } from '@/lib/ai/shared/hooks/useAgentConfig';
import { useProviderSettings } from '@/lib/ai/shared/hooks/useProviderSettings';
import { PageAgentHistoryTab, PageAgentSettingsTab, type PageAgentSettingsTabRef } from '@/components/ai/page-agents';
import { cn } from '@/lib/utils';
import EndSessionDialog from '../EndSessionDialog';
import { useResolvedAgent } from '../useResolvedAgent';
import SessionPanes from './SessionPanes';
import PaneBar, { PaneSessionIdentity, PaneSplitCloseActions } from './PaneBar';
import PanePicker, { type PickableAgent, type ReattachableShell } from './PanePicker';
import { resolvePaneSurface, type PaneSurface } from './pane-surface';
import { selectPaneAgent } from './select-pane-agent';
import { decideClosePane } from './close-pane';
import {
  agentSessionsKey,
  isAgentSessionsKey,
  type SessionConversationSummary,
  type SessionListEntry,
} from './session-conversations';
import PaneChat from './PaneChat';
import Shell from '../shell/Shell';

export interface AgentPanesProps {
  /** The session this grid belongs to (`agent_sessions.id`). */
  sessionId: string;
  /** The session's drive — where the picker's agent list comes from. Null for a global-assistant session. */
  driveId: string | null;
  /**
   * The session's FIRST conversation, used once to seed the opening pane (a
   * session is born with one — the grid never starts on a picker).
   */
  initialConversation: { conversationId: string; agentPageId: string | null; name: string };
  /** Fired after the last pane closed and the session was ended — the host owns what renders next. */
  onSessionEnded?: () => void;
  /**
   * Fired after a conversation's LISTING closed (its last pane, closed) —
   * `next` is the conversation the grid rebound its pane to, when closing
   * emptied the grid (`null` otherwise, or when there was nothing to rebind
   * to); `nextAgentPageId` is ITS agent, so a host tracking "current
   * conversation" independently of the grid's panes (its own selection
   * state, its own URL) can follow the rebind correctly rather than
   * guessing an agent from stale state. The host decides for itself what a
   * closed/rebound conversation means for whatever it is showing elsewhere.
   */
  onConversationClosed?: (event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => void;
  /**
   * Which message renderer chat panes use — the agent PAGE hosts the grid with
   * the full renderer, the console with the compact one. Layout is identical.
   */
  chatContext?: 'page' | 'console';
  /** Read-only viewers get history but no send/edit/delete/retry in any chat pane. */
  isReadOnly?: boolean;
}

async function shellsFetcher(url: string): Promise<{ shells: ReattachableShell[] }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to list shells (${response.status})`);
  return response.json();
}

/**
 * The same bulk listing the sidebar polls (`AgentsSidebar`) — SWR dedupes an
 * identical key, so mounting both costs one request, not two. Shared by both
 * pane-bar pure decisions: the pane bar selector's SWITCH decision
 * (`selectPaneAgent`, which of the session's agents already has a thread) and
 * the pane grid's CLOSE decision (`decideClosePane`, which needs it to tell
 * "the only pane left showing this conversation" apart from "the session's
 * only OPEN conversation" — the never-empty guard's client-side mirror; the
 * server enforces the real invariant regardless).
 */
async function sessionConversationsFetcher(url: string): Promise<{ sessions: SessionListEntry[] }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to list sessions (${response.status})`);
  return response.json();
}

export default function AgentPanes({
  sessionId,
  driveId,
  initialConversation,
  onSessionEnded,
  onConversationClosed,
  chatContext = 'console',
  isReadOnly = false,
}: AgentPanesProps) {
  const workspace = useAgentWorkspaceStore((state) => state.workspaces[sessionId]);
  const openConversation = useAgentWorkspaceStore((state) => state.openConversation);
  const splitRight = useAgentWorkspaceStore((state) => state.splitRight);
  const splitDown = useAgentWorkspaceStore((state) => state.splitDown);
  const closePane = useAgentWorkspaceStore((state) => state.closePane);
  const selectPane = useAgentWorkspaceStore((state) => state.selectPane);
  const assignPane = useAgentWorkspaceStore((state) => state.assignPane);
  const resetPane = useAgentWorkspaceStore((state) => state.resetPane);
  const replaceConversation = useAgentWorkspaceStore((state) => state.replaceConversation);
  const forgetWorkspace = useAgentWorkspaceStore((state) => state.forgetWorkspace);

  // The latest "assign this pane to conversation X" request per pane —
  // bumped by every such request (a History pick, an agent mint) so an
  // OLDER one's async completion (a slow reopen, a slow mint) can detect
  // it's been superseded and skip applying its now-stale result. A pane id
  // is reused across a pane's whole lifetime (split/close mint new ids, but
  // WITHIN one pane's life the id is stable), so a plain per-paneId counter
  // is enough — no cleanup needed, a closed pane's entry is simply never
  // read again (review finding — chatgpt-codex-connector on PR #2299: two
  // rapid History picks, or a History pick raced by an agent switch, could
  // resolve out of order and let network timing pick the visible
  // transcript).
  const paneAssignTokens = useRef(new Map<string, number>());
  const beginPaneAssign = useCallback((paneId: string) => {
    const token = (paneAssignTokens.current.get(paneId) ?? 0) + 1;
    paneAssignTokens.current.set(paneId, token);
    return () => paneAssignTokens.current.get(paneId) === token;
  }, []);

  // The picker's agent list. A drive session offers only that drive's agents;
  // a global-assistant session (driveId null) has no home drive to filter by,
  // so it offers every agent the caller can access, across all their drives —
  // billing/tenant still resolve to the session's own owner regardless of
  // which agent's conversation runs inside it (see AgentNotInSessionDriveError).
  const { allAgents, isLoading: agentsLoading } = usePageAgents(driveId ?? undefined);
  const pickableAgents: PickableAgent[] = useMemo(
    () =>
      (allAgents ?? [])
        .filter((agent) => driveId === null || agent.driveId === driveId)
        .map((agent) => ({
          id: agent.id,
          title: agent.title ?? 'Agent',
          // Only carried for a global session's cross-drive list — a single
          // drive's own picker has no cross-drive ambiguity to disambiguate.
          driveName: driveId === null ? agent.driveName : undefined,
        })),
    [allAgents, driveId],
  );

  // This session's shells, so the picker can offer to REATTACH one instead of
  // only spawning new — otherwise closing a terminal pane orphans its shell
  // with no way back short of the sidebar's (now-stale) count.
  const { data: shellsData } = useSWR(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/shells`,
    shellsFetcher,
    { revalidateOnFocus: false, refreshInterval: 15_000 },
  );
  const reattachableShells: ReattachableShell[] = useMemo(() => {
    const bound = new Set<string>();
    if (workspace) {
      for (const pane of panesOf(workspace)) {
        if (pane.scope?.kind === 'terminal' && pane.scope.targetId) bound.add(pane.scope.targetId);
      }
    }
    return (shellsData?.shells ?? []).filter((shell) => !bound.has(shell.shellId));
  }, [shellsData, workspace]);

  // This session's open conversation listings — shared by the pane bar
  // selector's SWITCH decision and the pane grid's CLOSE decision.
  const { data: sessionsData, mutate: mutateSessionConversations } = useSWR(
    agentSessionsKey(driveId),
    sessionConversationsFetcher,
    { revalidateOnFocus: false, refreshInterval: 20_000 },
  );
  // THIS session's own entry, looked up once and reused for both the
  // conversation list and the readiness check below — a session that
  // hasn't appeared here yet is not the same fact as an empty list.
  const currentSessionConversationsEntry = useMemo(
    () => (sessionsData?.sessions ?? []).find((session) => session.sessionId === sessionId),
    [sessionsData, sessionId],
  );
  const sessionConversations: SessionConversationSummary[] = useMemo(
    () => currentSessionConversationsEntry?.conversations ?? [],
    [currentSessionConversationsEntry],
  );
  // Ready only once THIS session's entry has actually appeared in the
  // cache — not merely once a fetch has settled. Two ways "settled" lies:
  // an initial-fetch ERROR leaves `sessionsData` undefined forever with
  // SWR's `isLoading` already back to false (SWR only tracks the fetch's
  // own pending state, not "do we have usable data"); and a cache that was
  // already warm from BEFORE this session was spawned (this SWR key is
  // shared across every session in the drive) answers with real data that
  // simply has no row for a session this new yet. Both leave
  // `sessionConversations` reading as `[]` — indistinguishable from "no
  // thread exists" — so the entry's actual presence, not a loading flag, is
  // the fact the switch decision needs.
  const sessionKnownToConversationsCache = currentSessionConversationsEntry !== undefined;

  // A successful mint writes straight into the pane store, but the switch
  // DECISION reads `sessionConversations` from this SWR cache, which only
  // catches up on its next 20s poll. Left alone, switching away from a
  // freshly-minted agent and back to it inside that window re-runs
  // `selectPaneAgent` against a list that still doesn't know the mint
  // happened — a second `mint` for the same agent, a duplicate conversation.
  // Writing the new row in here, locally, closes that window without
  // waiting on the network.
  const recordMintedConversation = useCallback(
    (conversationId: string, agentPageId: string | null) => {
      void mutateSessionConversations((current) => {
        if (!current) return current;
        return {
          sessions: current.sessions.map((session) =>
            session.sessionId === sessionId
              ? {
                  ...session,
                  conversations: [{ conversationId, agentPageId, lastMessageAt: null }, ...session.conversations],
                }
              : session,
          ),
        };
      }, { revalidate: false });
    },
    [mutateSessionConversations, sessionId],
  );
  // The mirror of `recordMintedConversation`, for the opposite direction: a
  // successful close stamps `closedInSessionAt` server-side immediately, but
  // this SWR cache only catches up on its next 20s poll (or a revalidate that
  // is itself in flight and could be slow or fail). Left alone,
  // `selectPaneAgent`'s switch decision — read by every OTHER pane's own
  // selector — still sees the just-closed row as open, so picking that same
  // agent elsewhere reads as `focus` and silently reopens a conversation the
  // server already considers closed, outside the History reopen flow
  // entirely (caught in review). Removing it here, locally, closes that
  // window without waiting on the network — same treatment as the mint side.
  const recordClosedConversation = useCallback(
    (conversationId: string) => {
      void mutateSessionConversations((current) => {
        if (!current) return current;
        return {
          sessions: current.sessions.map((session) =>
            session.sessionId === sessionId
              ? { ...session, conversations: session.conversations.filter((c) => c.conversationId !== conversationId) }
              : session,
          ),
        };
      }, { revalidate: false });
    },
    [mutateSessionConversations, sessionId],
  );
  // `decideClosePane` must not treat "not yet loaded" the same as "loaded and
  // empty" — a close must never act on an unverified fact, so it gets `null`
  // until the fetch actually resolves. Gated on `sessionKnownToConversationsCache`
  // (THIS session's own entry having appeared), not merely `sessionsData`
  // being truthy — a cache already warm from another session in the same
  // drive answers with real (truthy) data that simply has no row for a
  // brand-new session yet, which would otherwise read as a confirmed-empty
  // listing and wrongly offer to end the session on its first pane close
  // (caught in review). `selectPaneAgent`'s switch decision has no such
  // restriction (worst case for an early switch is a redundant mint).
  const closeDecisionListing: SessionConversationSummary[] | null = sessionKnownToConversationsCache
    ? sessionConversations
    : null;

  // Selection IS an instruction to show the conversation (review M1): on
  // mount this seeds the first pane; on a later selection within the same
  // session it focuses the pane already showing the thread, or opens it in a
  // non-terminal pane — the store owns that policy (`openConversation`).
  useEffect(() => {
    openConversation(sessionId, {
      kind: 'chat',
      name: initialConversation.name,
      targetId: initialConversation.conversationId,
      agentPageId: initialConversation.agentPageId,
    });
    // name/agentPageId describe the same conversation — the id is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialConversation.conversationId, openConversation]);

  // Ending the session: peeked, confirmed, and gated on the server (findings
  // 1 + 2). `pendingEndClose` carries the pane and its scope from the PEEK,
  // taken before any IO or mutation — so cancelling, or the DELETE failing,
  // leaves nothing to roll back.
  const [pendingEndClose, setPendingEndClose] = useState<{ paneId: string; scope: PaneScope | null } | null>(null);
  const [endingSession, setEndingSession] = useState(false);

  const closeShell = useCallback(
    (shellId: string) => {
      void del(`/api/agent-sessions/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}`).catch(
        (error) => {
          console.error('Failed to close shell:', error);
          toast.error('Could not close the shell', {
            description: error instanceof Error ? error.message : 'It may still be running.',
          });
        },
      );
    },
    [sessionId],
  );

  const closeTerminalShell = useCallback(
    (scope: PaneScope | null) => {
      if (scope?.kind === 'terminal' && scope.targetId) closeShell(scope.targetId);
    },
    [closeShell],
  );

  /**
   * Is `paneId` STILL in the SAME loading state this mint (or shell open)
   * left it in — not just present, but not yet reassigned to anything else.
   * A grid-last close can rebind this exact pane to another open listing
   * WHILE its own mint/shell-open request is still in flight; the request's
   * completion handler must not then clobber that rebind with its own
   * (now-abandoned) result just because the pane id still exists (caught
   * in review).
   */
  const paneStillLoading = useCallback(
    (paneId: string, scope: { kind: 'chat' | 'terminal'; agentPageId: string | null }) => {
      const current = useAgentWorkspaceStore.getState().workspaces[sessionId];
      const pane = current ? panesOf(current).find((p) => p.id === paneId) : undefined;
      return (
        pane?.scope?.kind === scope.kind &&
        pane.scope.targetId === null &&
        pane.scope.agentPageId === scope.agentPageId
      );
    },
    [sessionId],
  );

  /**
   * Is `paneId` STILL the pane bound to `conversationId`, right now? Checking
   * mere existence isn't enough: a slow DELETE can resolve after the user has
   * already repurposed this exact pane slot (switched its agent, minted a
   * new conversation into it) — the pane id still exists, but applying a
   * close/rebind meant for the OLD binding would destroy the user's newer
   * one (caught in review).
   */
  const paneStillShows = useCallback(
    (paneId: string, conversationId: string) => {
      const current = useAgentWorkspaceStore.getState().workspaces[sessionId];
      const pane = current ? panesOf(current).find((p) => p.id === paneId) : undefined;
      return pane?.scope?.kind === 'chat' && pane.scope.targetId === conversationId;
    },
    [sessionId],
  );

  /** Peek the pane's LIVE scope and open the end-session confirm dialog — shared by the direct decision and the 409 fallback below. */
  const beginEndSessionConfirm = useCallback(
    (paneId: string) => {
      const current = useAgentWorkspaceStore.getState().workspaces[sessionId];
      const pane = current ? panesOf(current).find((p) => p.id === paneId) : undefined;
      setPendingEndClose({ paneId, scope: pane?.scope ?? null });
    },
    [sessionId],
  );

  /**
   * Close conversation `conversationId`'s listing (the session-scoped DELETE)
   * — silent on success, since closing a listing never touches history (a
   * pane-close-lifecycle audit follow-up). `rebindTo`/`rebindAgentPageId` set
   * means this pane was the grid's last, so the grid never empties: it
   * repoints at that other open conversation instead of vanishing.
   */
  const closeConversationListing = useCallback(
    async (paneId: string, conversationId: string, rebindTo: string | null, rebindAgentPageId: string | null) => {
      try {
        await del(
          `/api/agent-sessions/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          // The session's LAST open listing — the server is the authority on
          // the never-empty invariant, so fall back to the same confirmed
          // end-session flow the grid's own last-pane close uses.
          if (!paneStillShows(paneId, conversationId)) return;
          beginEndSessionConfirm(paneId);
          return;
        }
        console.error('Failed to close this conversation:', error);
        toast.error('Could not close this conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        return;
      }

      if (paneStillShows(paneId, conversationId)) {
        if (rebindTo !== null) {
          replaceConversation(sessionId, conversationId, {
            kind: 'chat',
            name: 'Conversation',
            targetId: rebindTo,
            agentPageId: rebindAgentPageId,
          });
        } else {
          closePane(sessionId, paneId);
        }
        // Only tell the host to recover if THIS pane still shows the
        // conversation that closed. If the user reassigned this exact pane
        // (its own agent selector) while the DELETE was in flight,
        // `paneStillShows` already caught that above — but the host
        // (`AgentPageView`/`AgentsSurface`) tracks its own "current"
        // independently of any specific pane, so an unconditional callback
        // here would still tell it to recover from the now-irrelevant old
        // conversation, potentially overwriting what the user just picked
        // (caught in review).
        onConversationClosed?.({ conversationId, next: rebindTo, nextAgentPageId: rebindAgentPageId });
      }
      // The DELETE succeeded — this is true regardless of whether THIS pane
      // still shows it, so remove it from the local switch-decision cache
      // unconditionally (see `recordClosedConversation`'s own doc).
      recordClosedConversation(conversationId);
      // Instant sidebar freshness — the closed listing's row leaves every
      // open `/api/agent-sessions**` poll without waiting on its interval.
      void mutate(isAgentSessionsKey);
    },
    [
      sessionId,
      paneStillShows,
      beginEndSessionConfirm,
      replaceConversation,
      closePane,
      onConversationClosed,
      recordClosedConversation,
    ],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (!workspace) return;
      const pane = panesOf(workspace).find((p) => p.id === paneId);
      const decision = decideClosePane({
        panes: panesOf(workspace),
        paneId,
        activeConversations: closeDecisionListing,
      });

      if (decision.action === 'noop') return;

      if (decision.action === 'end-session') {
        // Emptying the session ends it — ask first, same as the sidebar's
        // identical act, and don't touch the grid until the user confirms.
        beginEndSessionConfirm(paneId);
        return;
      }

      if (decision.action === 'close-pane') {
        closePane(sessionId, paneId);
        closeTerminalShell(pane?.scope ?? null);
        return;
      }

      if (decision.action === 'rebind-pane') {
        // This pane addressed no conversation of its own (a terminal, a
        // picker, a still-minting chat) — nothing to DELETE, just a repoint.
        // Still close whatever WAS live here (e.g. a terminal's shell),
        // exactly as an ordinary close of it would.
        closeTerminalShell(pane?.scope ?? null);
        assignPane(sessionId, paneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: decision.conversationId,
          agentPageId: decision.agentPageId,
        });
        return;
      }

      void closeConversationListing(paneId, decision.conversationId, decision.rebindTo, decision.rebindAgentPageId);
    },
    [
      workspace,
      closePane,
      sessionId,
      closeTerminalShell,
      closeDecisionListing,
      closeConversationListing,
      assignPane,
      beginEndSessionConfirm,
    ],
  );

  const confirmEndSession = useCallback(async () => {
    if (!pendingEndClose) return;
    setEndingSession(true);
    let hadOtherOpenConversations = false;
    try {
      const ended = await del<{ hadOtherOpenConversations?: boolean }>(
        `/api/agent-sessions/${encodeURIComponent(sessionId)}`,
      );
      hadOtherOpenConversations = ended?.hadOtherOpenConversations ?? false;
    } catch (error) {
      // Nothing was mutated locally, so there is nothing to restore — the
      // grid the user is looking at is still exactly the live session.
      console.error('Failed to end session:', error);
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      setEndingSession(false);
      return;
    }
    // Server-confirmed: NOW the grid comes down. `forgetWorkspace` rather
    // than `closePane` — this can fire with OTHER panes still in the grid
    // (a terminal, say, when the closed listing was the session's last OPEN
    // conversation rather than the grid's last pane), and ending the session
    // tears down every one of them at once, not just the peeked pane's own.
    forgetWorkspace(sessionId);
    closeTerminalShell(pendingEndClose.scope);
    setEndingSession(false);
    setPendingEndClose(null);
    // Same instant-freshness nudge as closeConversationListing — otherwise
    // the now-dead session's row lingers in the sidebar until the next poll.
    void mutate(isAgentSessionsKey);
    if (hadOtherOpenConversations) {
      // Ending is unconditional by design — this can't be prevented client
      // side — but the confirm the user just clicked may have been shown
      // because THIS pane's own close 409'd on a stale "last listing" belief
      // (a conversation minted elsewhere committed between that 409 and this
      // confirm). Silently destroying more than expected deserves a signal,
      // even though nothing here can undo it (caught in review).
      toast.warning('This session had other open conversations, which were also ended.');
    }
    onSessionEnded?.();
  }, [pendingEndClose, sessionId, forgetWorkspace, closeTerminalShell, onSessionEnded]);

  const cleanupOrphanedConversation = useCallback(
    async (conversationId: string) => {
      // Best-effort: the pane that wanted this is already gone, so a failure
      // here just leaves a harmless unbound row rather than blocking anything
      // the user can see. Session-scoped close (not the history-deleting
      // page-agent/global routes) — this orphan never had any history, and
      // closing its listing also frees the conversation-cap slot it was
      // otherwise holding forever (a pre-existing defect this fixes).
      try {
        await del(
          `/api/agent-sessions/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        console.error('Failed to clean up an orphaned conversation:', error);
      }
    },
    [sessionId],
  );

  const handlePickAgent = useCallback(
    async (paneId: string, agentPageId: string | null) => {
      // Also supersedes any pending `handlePickHistoryConversation` call for
      // this pane — a slow reopen resolving after the user has since minted
      // a different agent into this same pane must not overwrite it (review
      // finding — chatgpt-codex-connector on PR #2299). This mint has its
      // OWN, separate staleness guard below (`paneStillLoading`); bumping
      // the shared token here just extends that same protection to the
      // OTHER call path.
      beginPaneAssign(paneId);
      const conversationId = createId();
      // Bind first, render after: the pane goes to `loading` (kind set, target
      // null) while the mint is in flight — never a speculative surface.
      assignPane(sessionId, paneId, { kind: 'chat', name: 'New conversation', targetId: null, agentPageId });
      try {
        if (agentPageId === null) {
          // The ASSISTANT: no agent page, so the session-centric creator is
          // the path (page-agents has no page to hang this on).
          await post(`/api/agent-sessions/${encodeURIComponent(sessionId)}/conversations`, {
            conversationId,
          });
        } else {
          await post(`/api/ai/page-agents/${encodeURIComponent(agentPageId)}/conversations`, {
            conversationId,
            sessionId,
          });
        }
        if (!paneStillLoading(paneId, { kind: 'chat', agentPageId })) {
          // The pane closed mid-mint, OR a grid-last close already rebound it
          // to another open listing while this request was in flight. Either
          // way, the row was already created server-side — clean it up
          // rather than leaving an orphaned, unbound thread (or clobbering
          // the rebind with this now-abandoned mint's result).
          void cleanupOrphanedConversation(conversationId);
          return;
        }
        assignPane(sessionId, paneId, { kind: 'chat', name: 'New conversation', targetId: conversationId, agentPageId });
        // Local optimistic update for THIS component's own switch/close
        // decisions (instant, no network)...
        recordMintedConversation(conversationId, agentPageId);
        // ...and a broader revalidate covering every OTHER `/api/agent-sessions**`
        // consumer (the sidebar, other panes) whose differently-scoped cache
        // key the local update above can't reach — it also re-fetches THIS
        // component's own key, which just confirms the optimistic patch above
        // moments later rather than conflicting with it. Without the
        // revalidate, `decideClosePane`'s `activeConversations` (a 20s poll)
        // can still lack this brand-new row elsewhere — closing this exact
        // pane before the next poll then reads it as "not in the open
        // listing" and takes the pure layout-close path instead of the
        // DELETE one, leaving an
        // orphaned conversation that holds a cap slot forever (caught in
        // review).
        void mutate(isAgentSessionsKey);
      } catch (error) {
        console.error('Failed to start a conversation in this pane:', error);
        toast.error('Could not start a conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        // Same rebind-survives rule as the success path above: a rejected
        // mint must not reset a pane a grid-last close already rebound to
        // something else while this request was in flight (caught in
        // review — the earlier fix only guarded the success path).
        if (paneStillLoading(paneId, { kind: 'chat', agentPageId })) {
          resetPane(sessionId, paneId);
        }
      }
    },
    [assignPane, resetPane, sessionId, paneStillLoading, cleanupOrphanedConversation, recordMintedConversation, beginPaneAssign],
  );

  /**
   * A pane's own History tab picking a past conversation — assign it to THIS
   * pane, reopening it into the session's listing first when it's bound to
   * THIS session and closed. A conversation that is unbound, or bound to a
   * DIFFERENT session, is never subject to this session's cap/listing at
   * all — no server call needed, straight to `assignPane` (the same client-
   * only mechanism `openConversation`/`handleSwitchAgent`'s focus branch
   * already use to point a pane at an existing conversationId). Verified
   * against the sandbox/tool-execution layer too (review question —
   * chatgpt-codex-connector on PR #2299): tool calls resolve their sandbox
   * from the CONVERSATION ROW's own persisted `sessionId`
   * (`findSessionForConversation`, a fresh DB read keyed only on
   * `conversationId`), never from which pane grid happens to display it —
   * so a foreign-session or unbound conversation opened here can never
   * execute tools against the wrong session's sandbox.
   *
   * Returns whether the pick actually landed — `false` on a failed reopen,
   * so the caller (the pane's own tab-switch) can stay on History rather
   * than following a pick that never happened (review finding —
   * chatgpt-codex-connector on PR #2299).
   */
  const handlePickHistoryConversation = useCallback(
    async (
      paneId: string,
      agentPageId: string | null,
      conversation: { id: string; title: string | null; sessionId: string | null },
    ): Promise<boolean> => {
      const isCurrent = beginPaneAssign(paneId);
      if (conversation.sessionId === sessionId) {
        try {
          await post(
            `/api/agent-sessions/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversation.id)}/reopen`,
            {},
          );
        } catch (error) {
          // A newer pick (or agent switch) on this pane already superseded
          // this one — its own outcome, success or failure, is no longer
          // this pane's concern, and surfacing an error toast for a request
          // the user has already moved past would be confusing.
          if (!isCurrent()) return false;
          console.error('Failed to reopen conversation:', error);
          toast.error('Could not reopen this conversation', {
            description: error instanceof Error ? error.message : 'Please try again.',
          });
          return false;
        }
        if (!isCurrent()) {
          // The reopen SUCCEEDED server-side (closedInSessionAt cleared, a
          // cap slot consumed) after a newer pick or agent mint already
          // superseded this one on the same pane — returning early without
          // undoing that leaves an invisible open listing occupying a slot
          // no pane shows, which can make a LATER reopen fail as "session
          // full" for no visible reason. Close it right back out, the same
          // way an orphaned mint is cleaned up above (review finding —
          // chatgpt-codex-connector on PR #2299).
          void cleanupOrphanedConversation(conversation.id);
          return false;
        }
        // Instant-freshness nudge, same as every other listing-changing
        // action here — the sidebar's own open list otherwise lags until its
        // next poll.
        void mutate(isAgentSessionsKey);
      }
      if (!isCurrent()) return false;
      // Already showing in another pane in THIS grid — focus it rather than
      // mounting a second, independently interactive surface for the same
      // transcript (review finding — chatgpt-codex-connector on PR #2299;
      // the same dedup `openConversation`'s own focus branch enforces
      // elsewhere, applied here since this path assigns directly rather
      // than going through that store action). Read FRESH, not the
      // `workspace` this callback closed over: two panes racing to reopen
      // the SAME closed conversation each run this check after their own
      // await, so a stale pre-request snapshot could make BOTH miss the
      // other's just-completed assignment and independently assign — the
      // exact duplicate this check exists to prevent (review finding —
      // chatgpt-codex-connector on PR #2299).
      const liveWorkspace = useAgentWorkspaceStore.getState().workspaces[sessionId];
      const existingPane = liveWorkspace
        ? panesOf(liveWorkspace).find(
            (p) => p.id !== paneId && p.scope?.kind === 'chat' && p.scope.targetId === conversation.id,
          )
        : undefined;
      if (existingPane) {
        // Deferred: the click that triggered this pick originated INSIDE
        // paneId's own DOM subtree, and `ChatPane`'s outer `group/pane` div
        // still has its own bubble-phase `onClick={onSelectPane}` — a plain
        // synchronous `selectPane` here would run before that handler and
        // get immediately clobbered back to paneId once bubbling reaches it
        // (caught in testing: `activePaneId` kept reverting to the pane the
        // pick was made FROM). A macrotask runs after the entire bubble
        // phase has finished, so this is the call that actually wins.
        setTimeout(() => selectPane(sessionId, existingPane.id), 0);
        return true;
      }
      assignPane(sessionId, paneId, {
        kind: 'chat',
        name: conversation.title || 'Conversation',
        targetId: conversation.id,
        agentPageId,
      });
      return true;
    },
    [sessionId, assignPane, selectPane, beginPaneAssign, cleanupOrphanedConversation],
  );

  /**
   * A pane's History tab deleting a conversation (`softDeleteConversation`
   * deactivates the CANONICAL row, not just this pane's own listing) —
   * every pane in THIS grid still pointing at that id, whichever pane's
   * History tab the delete came from, is left showing a dead transcript:
   * switching it back to Chat would render nothing sendable (the row now
   * 404s per the send-route's own isActive guard) with no obvious way out.
   * Reset each one to the picker — the simplest, safe recovery; the user
   * explicitly picks what's next rather than a guessed replacement (review
   * finding — chatgpt-codex-connector on PR #2299).
   */
  const handleHistoryDeleteConversation = useCallback(
    (deletedConversationId: string) => {
      // Read fresh at call time, not the `workspace` this callback closed
      // over — this always runs after the DELETE's own async round trip,
      // during which the user could have already reassigned an affected
      // pane to something else. Resetting based on the STALE pre-DELETE
      // snapshot would discard that newer selection even though the pane
      // no longer shows the deleted conversation at all (review finding —
      // chatgpt-codex-connector on PR #2299).
      const liveWorkspace = useAgentWorkspaceStore.getState().workspaces[sessionId];
      if (!liveWorkspace) return;
      const affectedPanes = panesOf(liveWorkspace).filter(
        (p) => p.scope?.kind === 'chat' && p.scope.targetId === deletedConversationId,
      );
      for (const pane of affectedPanes) {
        resetPane(sessionId, pane.id);
      }
      if (affectedPanes.length > 0) {
        void mutate(isAgentSessionsKey);
      }
    },
    [sessionId, resetPane],
  );

  // The pane bar selector's switch — focus-or-mint, decided by the pure
  // module above. Focusing reuses the store's dedup-aware `openConversation`
  // (the same conversation never shows in two panes at once — review M1);
  // minting reuses `handlePickAgent`'s own path, which binds THIS pane
  // directly, exactly as picking from the split picker already does.
  const handleSwitchAgent = useCallback(
    (paneId: string, currentAgentPageId: string | null, nextAgentPageId: string | null) => {
      const decision = selectPaneAgent({
        conversations: sessionConversations,
        selectedAgentPageId: nextAgentPageId,
        currentAgentPageId,
      });
      if (decision.action === 'noop') return;
      if (decision.action === 'focus') {
        openConversation(sessionId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: decision.conversationId,
          agentPageId: nextAgentPageId,
        });
        return;
      }
      void handlePickAgent(paneId, nextAgentPageId);
    },
    [sessionConversations, sessionId, openConversation, handlePickAgent],
  );

  const handlePickShell = useCallback(
    async (paneId: string) => {
      assignPane(sessionId, paneId, { kind: 'terminal', name: 'shell', targetId: null, agentPageId: null });
      try {
        const { shell } = await post<{ shell: { shellId: string; name: string } }>(
          `/api/agent-sessions/${encodeURIComponent(sessionId)}/shells`,
          {},
        );
        if (!paneStillLoading(paneId, { kind: 'terminal', agentPageId: null })) {
          // Same staleness rule as a conversation mint (including the
          // grid-last-rebind case): the shell exists server-side already, so
          // close it rather than leave it running unattached or clobber
          // whatever this pane was rebound to meanwhile.
          closeShell(shell.shellId);
          return;
        }
        assignPane(sessionId, paneId, { kind: 'terminal', name: shell.name, targetId: shell.shellId, agentPageId: null });
      } catch (error) {
        console.error('Failed to open a shell in this pane:', error);
        toast.error('Could not open a shell', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        // Same rebind-survives rule as the success path above and as
        // handlePickAgent's catch block: a rejected shell-open must not reset
        // a pane a grid-last close already rebound to something else while
        // this request was in flight (caught in review — the earlier fix
        // only guarded the success path).
        if (paneStillLoading(paneId, { kind: 'terminal', agentPageId: null })) {
          resetPane(sessionId, paneId);
        }
      }
    },
    [assignPane, resetPane, sessionId, paneStillLoading, closeShell],
  );

  const handleReattachShell = useCallback(
    (paneId: string, shellId: string, name: string) => {
      assignPane(sessionId, paneId, { kind: 'terminal', name, targetId: shellId, agentPageId: null });
    },
    [assignPane, sessionId],
  );

  if (!workspace) {
    // The openConversation effect seeds the grid on the next tick.
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderPane = ({ pane, isActive, canSplit }: { pane: PaneState; isActive: boolean; canSplit: boolean }) => {
    const surface = resolvePaneSurface(pane.scope);

    // A chat pane owns real Chat/History/Settings tabs and the state that
    // switches between them — pulled into its own component (not inlined
    // here) for the same reason `ChatPaneIdentity`/`ChatPane`'s predecessor
    // was: hooks cannot run inside a render-prop map across a pane count
    // that changes on every split/close.
    if (pane.scope?.kind === 'chat') {
      return (
        <ChatPane
          scope={pane.scope}
          surface={surface}
          isActive={isActive}
          canSplit={canSplit}
          pickableAgents={pickableAgents}
          agentsLoading={agentsLoading}
          conversationsReady={sessionKnownToConversationsCache}
          driveId={driveId}
          sessionId={sessionId}
          chatContext={chatContext}
          isReadOnly={isReadOnly}
          onSelectAgent={(nextAgentPageId) => handleSwitchAgent(pane.id, pane.scope!.agentPageId, nextAgentPageId)}
          onSelectPane={() => selectPane(sessionId, pane.id)}
          onSplitRight={() => splitRight(sessionId, pane.id)}
          onSplitDown={() => splitDown(sessionId, pane.id)}
          onClose={() => handleClosePane(pane.id)}
          onCreateNewFromHistory={() => void handlePickAgent(pane.id, pane.scope!.agentPageId)}
          onPickHistoryConversation={(conversation) =>
            handlePickHistoryConversation(pane.id, pane.scope!.agentPageId, conversation)
          }
          onHistoryDeleteConversation={handleHistoryDeleteConversation}
        />
      );
    }

    // Unbound (scope null) is the only picker shape now — `resetPane` is the
    // one path back to it, so there is no longer a bound-but-empty sentinel
    // to also treat as one (issue #2263, finding 5).
    const showPicker = surface.surface === 'picker';

    return (
      <div
        className="group/pane flex h-full min-h-0 flex-col"
        onClick={() => selectPane(sessionId, pane.id)}
        // Tabbing into any control inside a pane (the chat input, a close
        // button) must activate it too — a click is not the only way in.
        onFocusCapture={() => selectPane(sessionId, pane.id)}
      >
        <PaneBar
          isActive={isActive}
          identity={
            pane.scope ? (
              <PaneSessionIdentity name={pane.scope.name || 'pane'} />
            ) : (
              <span className="text-muted-foreground">New pane</span>
            )
          }
          actions={
            <PaneSplitCloseActions
              canSplit={canSplit}
              canClose
              onSplitRight={() => splitRight(sessionId, pane.id)}
              onSplitDown={() => splitDown(sessionId, pane.id)}
              onClose={() => handleClosePane(pane.id)}
            />
          }
        />
        <div className="min-h-0 flex-1">
          {showPicker ? (
            <PanePicker
              agents={pickableAgents}
              isLoading={agentsLoading}
              existingShells={reattachableShells}
              // The assistant identity path is live (AssistantSessionChat), so
              // every session can host an assistant thread beside its agents.
              // Confirmed intent (was flagged in issue #2263, finding 8, as a
              // product decision to confirm): every session offers the global
              // assistant, symmetric with a global session now offering every
              // accessible agent (see pickableAgents above).
              canPickAssistant
              autoFocus={workspace.pendingPickerPaneId === pane.id}
              onPickAgent={(agentPageId) => void handlePickAgent(pane.id, agentPageId)}
              onPickShell={() => void handlePickShell(pane.id)}
              onReattachShell={(shellId, name) => handleReattachShell(pane.id, shellId, name)}
            />
          ) : surface.surface === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : surface.surface === 'terminal' ? (
            <Shell shellId={surface.shellId} name={pane.scope?.name} />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <SessionPanes workspace={workspace} onSelectPane={(paneId) => selectPane(sessionId, paneId)} renderPane={renderPane} />
      <EndSessionDialog
        open={pendingEndClose !== null}
        onOpenChange={(open) => {
          if (!open) setPendingEndClose(null);
        }}
        isEnding={endingSession}
        onConfirm={() => void confirmEndSession()}
      />
    </>
  );
}

type PaneChatTab = 'chat' | 'history' | 'settings';

/**
 * A chat pane, in full: the bar identity (AISelector + Chat/History/Settings
 * tab strip) AND the body those tabs switch between. One component, not two,
 * because the tabs live in the bar but the state they drive has to reach the
 * body below it — `renderPane` itself cannot hold that state (a plain
 * function invoked per pane, not a component; hooks would violate their own
 * rules across a pane count that changes on every split/close), so this is
 * the pane-bar-plus-body wrapper every OTHER pane kind's inline JSX in
 * `renderPane` also uses, just pulled out for this one kind's own hooks.
 *
 * History and Settings reuse the SAME hooks (`useConversations`,
 * `useAgentConfig`) the page's own `AgentPageView` tabs use — the whole
 * point (raised in review on PR #2296/#2299) being that a pane and the page
 * view are not two parallel implementations of "this agent's history/
 * settings": they are the same SWR-keyed data, so two panes on the same
 * agent (or a pane and the page view) can never silently drift.
 */
function ChatPane({
  scope,
  surface,
  isActive,
  canSplit,
  pickableAgents,
  agentsLoading,
  conversationsReady,
  driveId,
  sessionId,
  chatContext,
  isReadOnly,
  onSelectAgent,
  onSelectPane,
  onSplitRight,
  onSplitDown,
  onClose,
  onCreateNewFromHistory,
  onPickHistoryConversation,
  onHistoryDeleteConversation,
}: {
  /** Always `kind: 'chat'` at the call site — `PaneScope` isn't a discriminated union, so this stays the full type. */
  scope: PaneScope;
  surface: PaneSurface;
  isActive: boolean;
  canSplit: boolean;
  pickableAgents: PickableAgent[];
  agentsLoading: boolean;
  /**
   * Whether THIS session's entry has appeared in the switch decision's own
   * data (`sessionConversations`). Before it has, that list reads as `[]` —
   * indistinguishable from "no conversation with this agent exists yet" —
   * and a switch to an agent that already HAS a thread would wrongly mint a
   * duplicate instead of focusing it. Disabled here rather than raced.
   */
  conversationsReady: boolean;
  driveId: string | null;
  sessionId: string;
  chatContext?: 'page' | 'console';
  isReadOnly: boolean;
  onSelectAgent: (agentPageId: string | null) => void;
  onSelectPane: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
  onCreateNewFromHistory: () => void;
  /** Resolves to whether the pick actually landed — false on a failed reopen. */
  onPickHistoryConversation: (conversation: { id: string; title: string | null; sessionId: string | null }) => Promise<boolean>;
  /** A History delete's canonical-row deactivation reaches every pane showing that id, not just this one — the container resets each affected pane. */
  onHistoryDeleteConversation: (conversationId: string) => void;
}) {
  const { user } = useAuth();
  const { agent } = useResolvedAgent(scope.agentPageId);
  const conversationId = surface.surface === 'chat' ? surface.conversationId : null;
  // The channel a stream for this conversation would be tagged with — an
  // agent's own page id, or the user's global channel for the Assistant
  // (`useAssistantSessionChat`'s own scoping, mirrored here).
  const streamPageId = scope.agentPageId ?? (user?.id ? globalChannelId(user.id) : null);
  const activeStream = useConversationActiveStream(streamPageId, conversationId);
  // Mid-mint (the row isn't there yet), mid-stream, or the switch decision's
  // own data doesn't know this session yet: none of these have anything
  // safe to switch against.
  const disabledAgentSwitch = surface.surface === 'loading' || activeStream !== undefined || !conversationsReady;

  const [activeTab, setActiveTab] = useState<PaneChatTab>('chat');

  // A pane's agent can change under it (the AISelector switch) without
  // remounting this component. Settings belongs to the OLD agent — showing
  // it (or leaving `activeTab: 'settings'` set) after switching to a
  // DIFFERENT agent presents that agent's config as if requested, and
  // switching to the Assistant (no Settings tab at all) leaves the body on
  // its final "not agentPageId or no agent" branch, a spinner that never
  // resolves since neither condition can ever become true again for this
  // scope (review finding — coderabbitai on PR #2299).
  useEffect(() => {
    setActiveTab('chat');
  }, [scope.agentPageId]);

  const {
    conversations,
    isLoading: conversationsLoading,
    deleteConversation,
  } = useConversations({
    agentId: scope.agentPageId,
    currentConversationId: conversationId,
    // Only fetched while History is actually showing — same lazy-load
    // discipline `AgentPageView`'s own History tab uses.
    enabled: activeTab === 'history',
  });

  const { config: agentConfig, setConfig: setAgentConfig } = useAgentConfig(scope.agentPageId);
  const {
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings(scope.agentPageId ? { pageId: scope.agentPageId } : {});
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const settingsRef = useRef<PageAgentSettingsTabRef>(null);

  const toggleConversationShare = useCallback(
    async (targetConversationId: string, isShared: boolean) => {
      if (scope.agentPageId === null) return;
      try {
        const response = await fetchWithAuth(
          `/api/ai/page-agents/${scope.agentPageId}/conversations/${targetConversationId}`,
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
    [scope.agentPageId],
  );

  const handleSelectHistoryConversation = useCallback(
    async (id: string) => {
      const picked = conversations.find((c) => c.id === id);
      // Only follow the pick to Chat once it actually landed — a failed
      // reopen (session full, deleted, access changed) leaves the pane
      // untouched, and switching tabs anyway would show the OLD pane
      // content as if the pick had succeeded (review finding —
      // chatgpt-codex-connector on PR #2299).
      const landed = await onPickHistoryConversation({
        id,
        title: picked?.title ?? null,
        sessionId: picked?.sessionId ?? null,
      });
      if (landed) setActiveTab('chat');
    },
    [conversations, onPickHistoryConversation],
  );

  const handleCreateNewFromHistory = useCallback(() => {
    onCreateNewFromHistory();
    setActiveTab('chat');
  }, [onCreateNewFromHistory]);

  return (
    <div
      className="group/pane flex h-full min-h-0 flex-col"
      onClick={onSelectPane}
      // Tabbing into any control inside a pane (the chat input, a close
      // button) must activate it too — a click is not the only way in.
      onFocusCapture={onSelectPane}
    >
      <PaneBar
        isActive={isActive}
        identity={
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <AISelector
              selectedAgent={scope.agentPageId === null ? null : agent}
              onSelectAgent={(next) => onSelectAgent(next?.id ?? null)}
              driveId={driveId ?? undefined}
              agents={pickableAgents}
              agentsLoading={agentsLoading}
              disabled={disabledAgentSwitch}
              className="h-6 min-w-0 flex-1 justify-start gap-1 px-1.5 py-0 text-xs font-medium"
            />
            <PaneChatTabStrip
              activeTab={activeTab}
              onSelectTab={setActiveTab}
              // The Assistant (agentPageId null) has no page, so no Settings —
              // every other pane's agent does.
              showSettings={scope.agentPageId !== null}
              agentTitle={agent?.title ?? 'Agent'}
            />
          </div>
        }
        actions={
          <>
            {activeTab === 'settings' && scope.agentPageId !== null && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  settingsRef.current?.submitForm();
                }}
                // `PageAgentSettingsTab` registers `submitForm` before its own
                // config-loaded check returns, and its form defaults contain
                // an EMPTY prompt/tool list — clicking Save before agentConfig
                // arrives would PATCH those defaults over the agent's real
                // config (review finding — chatgpt-codex-connector on PR
                // #2299).
                disabled={isSettingsSaving || agentConfig === null}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {isSettingsSaving ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Save className="size-3" aria-hidden="true" />}
                Save
              </button>
            )}
            <PaneSplitCloseActions
              canSplit={canSplit}
              canClose
              onSplitRight={onSplitRight}
              onSplitDown={onSplitDown}
              onClose={onClose}
            />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'chat' ? (
          surface.surface === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : surface.surface === 'chat' ? (
            <PaneChat
              conversationId={surface.conversationId}
              agentPageId={surface.agentPageId}
              driveId={driveId}
              context={chatContext}
              isReadOnly={isReadOnly}
            />
          ) : null
        ) : activeTab === 'history' ? (
          <PageAgentHistoryTab
            conversations={conversations}
            currentConversationId={conversationId}
            onSelectConversation={handleSelectHistoryConversation}
            onCreateNew={handleCreateNewFromHistory}
            onDeleteConversation={(id) => {
              // Only rebind panes once the delete actually succeeded — a
              // refused delete (the never-empty guard's 409, e.g.) or a
              // network failure both leave the conversation exactly as it
              // was server-side, and resetting live panes for it anyway
              // would discard a working pane binding for nothing (review
              // finding — chatgpt-codex-connector and coderabbitai on PR
              // #2299).
              void deleteConversation(id).then((succeeded) => {
                if (succeeded) onHistoryDeleteConversation(id);
              });
            }}
            onToggleShare={toggleConversationShare}
            isLoading={conversationsLoading}
          />
        ) : scope.agentPageId !== null && agent ? (
          <div className="h-full overflow-auto">
            <PageAgentSettingsTab
              ref={settingsRef}
              pageId={scope.agentPageId}
              driveId={agent.driveId}
              config={agentConfig}
              onConfigUpdate={setAgentConfig}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onProviderChange={setSelectedProvider}
              onModelChange={setSelectedModel}
              isProviderConfigured={isProviderConfigured}
              onSavingChange={setIsSettingsSaving}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The tab strip itself — icon-only (a pane bar is 30px tall, no room for
 * `AgentPageView`'s spacious text pills), tooltipped/aria-labeled for the
 * text a mouse-hover or screen reader still needs.
 */
function PaneChatTabStrip({
  activeTab,
  onSelectTab,
  showSettings,
  agentTitle,
}: {
  activeTab: PaneChatTab;
  onSelectTab: (tab: PaneChatTab) => void;
  showSettings: boolean;
  agentTitle: string;
}) {
  const tabButton = (tab: PaneChatTab, label: string, Icon: typeof MessageSquare) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onSelectTab(tab);
      }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        activeTab === tab && 'bg-accent text-foreground',
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
    </button>
  );

  return (
    <div role="tablist" className="flex shrink-0 items-center gap-0.5">
      {tabButton('chat', 'Chat', MessageSquare)}
      {tabButton('history', 'History', History)}
      {showSettings && tabButton('settings', `${agentTitle} settings`, Settings)}
    </div>
  );
}

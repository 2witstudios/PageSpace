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
 *      picker   → PanePicker      (unbound — choose an agent, a shell, a
 *                                  page, or reattach a shell already running)
 *      chat     → PaneChat        (a conversation IN this session)
 *      terminal → Shell           (a PTY on this session's sandbox)
 *      page     → PagePaneView    (a PageSpace page — document, task list,
 *                                  sheet, canvas, code, ... — rendered with
 *                                  the same view the main content area uses)
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
import { Check, History, Loader2, MessageSquare, Plus, Save, Settings } from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { mutate } from 'swr';
import type { PaneScope } from '@pagespace/lib/agent-workspaces/contract';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { fetchWithAuth, post, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useWorkspaceLayoutSync } from '@/stores/agent-workspace/useWorkspaceLayoutSync';
import { panesOf, isLastPane, paneShowing, type PaneState } from '@/stores/agent-workspace/pane-reducer';
import { usePageAgents } from '@/hooks/page-agents/usePageAgents';
import { useAuth } from '@/hooks/useAuth';
import { useConversationActiveStream } from '@/hooks/useActiveStream';
import { AISelector } from '@/components/ai/shared';
import { useConversations } from '@/lib/ai/shared/hooks/useConversations';
import { useAgentConfig } from '@/lib/ai/shared/hooks/useAgentConfig';
import { useAgentSettingsSaveState } from '@/lib/ai/shared/hooks/useAgentSettingsSaveState';
import { useProviderSettings } from '@/lib/ai/shared/hooks/useProviderSettings';
import { PageAgentHistoryTab, PageAgentSettingsTab, type PageAgentSettingsTabRef } from '@/components/ai/page-agents';
import { cn } from '@/lib/utils';
import EndSessionDialog from '../EndSessionDialog';
import { useResolvedAgent } from '../useResolvedAgent';
import { useSessionRecord } from '../useSessionRecord';
import SessionPanes from './SessionPanes';
import PaneBar, { PaneSessionIdentity, PaneSplitCloseActions } from './PaneBar';
import PanePicker, { type PickableAgent, type ReattachableShell } from './PanePicker';
import { resolvePaneSurface, type PaneSurface } from './pane-surface';
import { selectPaneAgent } from './select-pane-agent';
import { decideClosePane } from './close-pane';
import {
  agentSessionsKey,
  isAgentSessionsKey,
  isSessionListingKey,
  forgetSessionInCache,
  restoreSessionInCache,
  type SessionConversationSummary,
  type SessionListEntry,
} from './session-conversations';
import PaneChat from './PaneChat';
import PagePaneView from './PagePaneView';
import Shell from '../shell/Shell';

export interface AgentPanesProps {
  /** The session this grid belongs to (`agent_workspaces.id`). */
  sessionId: string;
  /** The session's drive — where the picker's agent list comes from. Null for a global-assistant session. */
  driveId: string | null;
  /**
   * The session's FIRST conversation, used once to seed the opening pane (a
   * session is born with one — the grid never starts on a picker). Null for
   * a session-only selection (a page/terminal row in the sidebar, a
   * conversation-less deep link): there is nothing to seed or assert, the
   * grid renders whatever the store/hydration holds.
   */
  initialConversation: { conversationId: string; agentPageId: string | null; name: string } | null;
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
  /**
   * The conversation the HOSTING AI_CHAT page's own header is currently showing, when
   * this is that page's own embedded grid — the one pane bound to exactly this
   * conversation is displaying the same thing the page's own selector/Chat/History/
   * Settings chrome already identifies, so its pane bar drops to a plain label instead.
   * Deliberately keyed by CONVERSATION, not agent: a split pane the user pointed at the
   * same agent but a DIFFERENT conversation (via the picker) is still a distinct thing
   * the page's own header isn't showing — it keeps its full selector/tab-strip, since
   * that's its only in-grid way to be managed. Undefined for the console, which has no
   * single hosting page.
   */
  hostConversationId?: string | null;
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
 * identical key, so mounting both costs one request, not two. Shared by
 * every pane pure decision: the switch decision (`selectPaneAgent`, which
 * agent already has a thread elsewhere in the session) and the close decision
 * (`decideClosePane`, which needs it to tell "shown in another pane" apart
 * from "the session's only OPEN conversation" — the never-empty guard's
 * client-side mirror; the server enforces the real invariant regardless).
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
  hostConversationId,
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
  const forgetWorkspace = useAgentWorkspaceStore((state) => state.forgetWorkspace);
  const hydrateWorkspace = useAgentWorkspaceStore((state) => state.hydrateWorkspace);
  const replaceConversation = useAgentWorkspaceStore((state) => state.replaceConversation);
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);

  // Whether THIS session's payer (not the viewing user) is sandbox-eligible —
  // server-resolved (the client only knows its own tier, the wrong axis for
  // a shared drive). Defaults to true while unresolved: a session that has
  // ALREADY provisioned a Sprite (most of what this grid renders) is proof
  // enough that it was eligible; the picker's "Shell"/reattach buttons are
  // the only things this actually gates, and they mustn't flash disabled on
  // every mount before this fetch resolves.
  const { data: sessionRecordData } = useSessionRecord(sessionId);
  const canRunSandbox = sessionRecordData?.sandboxEligible ?? true;

  // The grid is SERVER-AUTHORITATIVE: the store posts each mutation as its
  // own verb, and this hook supplies the other direction — the mount-time
  // snapshot and the `session:<id>` room that keeps it live (another device,
  // or an agent placing a pane server-side). Unconditional, unlike the
  // debounced PUT it replaces: that hook was disabled for read-only viewers
  // because they have nothing to WRITE, but reading is exactly what they do,
  // and with the localStorage grid copy gone the server snapshot is the only
  // place their layout can come from at all.
  useWorkspaceLayoutSync(sessionId);

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

  // Races the pane-token above can't catch on its own, since it's scoped
  // per PANE while these are scoped per CONVERSATION (review findings —
  // chatgpt-codex-connector on PR #2299, rounds 8-9):
  //
  // 1. The SAME conversation picked twice (same pane or two panes) can have
  //    the OLDER reopen resolve first while the NEWER one is still in
  //    flight — at that instant no pane shows it yet, so the older (stale)
  //    request's "is anyone showing this?" check reads false-orphaned and
  //    closes the conversation the newer request is about to legitimately
  //    land. Tracked as an in-flight count per conversationId; the rollback
  //    below only fires once nothing else is still reopening the same id.
  //
  //    That alone still drops the ball when the LAST settler is the one
  //    that FAILS: an earlier (superseded) reopen for the same id can
  //    succeed-but-defer its own rollback because this one was still
  //    pending — if this one then rejects instead of landing it, nothing
  //    is left to finish that deferred cleanup. `deferredReopenSuccess`
  //    marks that case; whichever request is the LAST to settle for a
  //    given conversationId (by count reaching zero) is responsible for
  //    checking it and finishing the cleanup if still nothing shows it.
  const pendingReopenCounts = useRef(new Map<string, number>());
  const deferredReopenSuccess = useRef(new Set<string>());
  // Same coordination, for the CLAIM branch below (a never-bound row picked
  // twice rapidly races exactly like a reopen does: the request that lands
  // the actual claim can go stale and see "nothing shows it yet" before the
  // now-current, later request has assigned it — review finding, chatgpt-
  // codex-connector: reusing the counters above would conflate the two
  // operations under one key namespace for no benefit, so this is a
  // parallel pair instead of a rename).
  const pendingClaimCounts = useRef(new Map<string, number>());
  const deferredClaimSuccess = useRef(new Set<string>());
  // 2. A reopen can commit server-side, then have its OWN response delayed
  //    long enough for the SAME conversation to be deleted from History (a
  //    different pane, or the same one) before the reopen's completion
  //    assigns it — landing a pane on a transcript that already 404s on
  //    send. A single consumable flag isn't enough here either: TWO panes
  //    concurrently reopening the same conversation both need to observe
  //    the same delete, but a boolean/Set entry consumed by whichever
  //    completion checks it first would leave the second one blind. A
  //    per-conversationId generation counter instead: each reopen captures
  //    the generation at start, `handleHistoryDeleteConversation` bumps it
  //    on delete, and every completion (however many are in flight)
  //    independently compares its own captured start value against the
  //    current one — no consumption, so no reader ever misses it.
  const historyDeleteGenerations = useRef(new Map<string, number>());
  // 3. New Conversation from History captures the pane's PRIOR scope so a
  //    failed mint can restore it (round 13) — but re-reading "the live
  //    scope right now" at the start of EVERY call breaks the moment two
  //    mints for the SAME pane overlap: the second call's "live scope" is
  //    already the FIRST call's loading sentinel, not the true original.
  //    A failed second call would then "restore" that sentinel, leaving the
  //    pane stuck spinning forever. Captured ONCE per paneId (only by
  //    whichever mint is first to start while none is in flight) and reused
  //    by every overlapping sibling; reference-counted so the entry clears
  //    once every overlapping mint for that pane has settled, letting a
  //    LATER, non-overlapping mint capture fresh state again (review
  //    finding — chatgpt-codex-connector on PR #2299, round 15).
  const pendingMintCounts = useRef(new Map<string, number>());
  const priorScopeBeforeMint = useRef(
    new Map<string, { scope: PaneScope | null; deleteGenerationAtStart: number }>(),
  );

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
    `/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells`,
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
    {
      revalidateOnFocus: false,
      // BACKSTOP, not the mechanism (Agent-Session SSoT epic, Phase 2 / plan PR 4).
      // `session-directory-listener.ts` now applies `conversation:created/updated/
      // closed/reopened/deleted` and `session:*` to this exact cache the moment they
      // happen, so the poll no longer carries the freshness of the listing — it only
      // catches the case where a broadcast was lost entirely. Demoted from 20s to
      // 120s; SLATED FOR DELETION at the epic's final contract PR, once the legacy
      // `chat:*` emissions are gone and the directory plane is the only path.
      refreshInterval: 120_000,
    },
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
  // successful close stamps `closedInWorkspaceAt` server-side immediately, but
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
    // Session-only selection (no conversation named): nothing to seed or
    // assert — the grid is whatever the store already holds or server
    // hydration seats.
    if (!initialConversation) return;
    const workspace = useAgentWorkspaceStore.getState().workspaces[sessionId];
    // A brand-new grid (`ensureWorkspace`'s fast path) or a target that's
    // already showing (`openConversation`'s own focus path) never reaches
    // `isReplaceable`'s eviction logic, so there is nothing to protect —
    // safe to seed immediately regardless of cache readiness. Otherwise,
    // WAIT for the live set before risking an eviction decision at all:
    // calling this with an unprotected `undefined` set on a pre-existing
    // grid would let a cold reload or a slow/failed listing fetch reproduce
    // the exact eviction issue #2295 fixes — and since
    // `sessionKnownToConversationsCache` is otherwise excluded from this
    // effect's deps (to avoid re-seeding on every 20s poll), a later
    // successful fetch could never repair a premature eviction after the
    // fact (review finding, PR #2307). `sessionKnownToConversationsCache`
    // is safe to depend on despite that: it only flips false→true once
    // (unlike `sessionConversations`, whose array reference changes on
    // every poll), so this adds at most one extra effect run, not a
    // recurring one.
    const alreadyShowing = workspace ? paneShowing(workspace, initialConversation.conversationId) !== undefined : false;
    if (workspace && !alreadyShowing && !sessionKnownToConversationsCache) return;

    openConversation(
      sessionId,
      {
        kind: 'chat',
        name: initialConversation.name,
        targetId: initialConversation.conversationId,
        agentPageId: initialConversation.agentPageId,
      },
      {
        liveConversationIds: sessionKnownToConversationsCache
          ? new Set(sessionConversations.map((c) => c.conversationId))
          : undefined,
      },
    );
    // name/agentPageId describe the same conversation — the id is the identity.
    // sessionConversations itself deliberately excluded from the dep array —
    // its ARRAY REFERENCE changes on every 20s poll and would re-run the seed
    // on every tick — but reading it directly in the closure (rather than via
    // a ref) is still exactly as fresh as it needs to be: it is recomputed
    // from the same `sessionsData` in the same render that flips
    // `sessionKnownToConversationsCache`, so whenever THIS effect actually
    // re-runs (on that flip), the closure it runs with already has the
    // matching, up-to-date value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialConversation?.conversationId, openConversation, sessionKnownToConversationsCache]);

  // Ending the session: peeked, confirmed, and gated on the server (findings
  // 1 + 2). `pendingEndClose` carries the pane and its scope from the PEEK,
  // taken before any IO or mutation — so cancelling, or the DELETE failing,
  // leaves nothing to roll back.
  const [pendingEndClose, setPendingEndClose] = useState<{ paneId: string; scope: PaneScope | null } | null>(null);

  const closeShell = useCallback(
    (shellId: string) => {
      void del(`/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}`).catch(
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
   * Is `paneId` STILL the pane bound to `conversationId`, right now? Checking
   * mere existence isn't enough: a slow DELETE can resolve after the user has
   * already repurposed this exact pane slot (switched its agent, minted a
   * new conversation into it) — the pane id still exists, but applying a
   * close/rebind meant for the OLD binding would destroy the user's newer
   * one.
   */
  const paneStillShows = useCallback(
    (paneId: string, conversationId: string) => {
      const current = useAgentWorkspaceStore.getState().workspaces[sessionId];
      const pane = current ? panesOf(current).find((p) => p.id === paneId) : undefined;
      return pane?.scope?.kind === 'chat' && pane.scope.targetId === conversationId;
    },
    [sessionId],
  );

  /**
   * Close conversation `conversationId`'s listing (the session-scoped
   * DELETE) — silent on success, since closing a listing never touches
   * history. `rebindTo`/`rebindAgentPageId` set means this pane was the
   * grid's last, so the grid never empties: it repoints at that other open
   * conversation instead of vanishing.
   */
  const closeConversationListing = useCallback(
    async (paneId: string, conversationId: string, rebindTo: string | null, rebindAgentPageId: string | null) => {
      try {
        await del(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          // The session's LAST open listing — the server is the authority on
          // the never-empty invariant, so fall back to the same confirmed
          // end-session flow every other last-pane close uses.
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
          // `rebindTo === null` here means either this pane isn't the grid's
          // last one (closePane is the right, ordinary layout removal), OR
          // it IS the last one and `decideClosePane`'s own client-side
          // snapshot found no other listing to rebind to — but the DELETE
          // just succeeded anyway (the server, not this stale snapshot, is
          // the authority on "last listing"), so another listing must exist
          // server-side that this client didn't know about. `closePane`
          // REFUSES to remove a grid's only pane (the never-empty
          // invariant), so calling it here would silently no-op and leave
          // this pane's scope pointed at the conversation that just closed,
          // forever. Check fresh, live state (not the closure's own
          // `workspace`) since a split/close could have landed while this
          // DELETE was in flight (review finding — coderabbitai on
          // PR #2308).
          const liveWorkspaceNow = useAgentWorkspaceStore.getState().workspaces[sessionId];
          if (liveWorkspaceNow && isLastPane(liveWorkspaceNow, paneId)) {
            resetPane(sessionId, paneId);
          } else {
            closePane(sessionId, paneId);
          }
        }
        // Only tell the host to recover if THIS pane still shows the
        // conversation that closed — a user reassignment of this exact pane
        // while the DELETE was in flight is already caught by
        // `paneStillShows` above.
        onConversationClosed?.({ conversationId, next: rebindTo, nextAgentPageId: rebindAgentPageId });
      }
      // The DELETE succeeded — this is true regardless of whether THIS pane
      // still shows it, so remove it from the local switch-decision cache
      // unconditionally (see `recordClosedConversation`'s own doc).
      recordClosedConversation(conversationId);
      // Instant sidebar freshness — the closed listing's row leaves every
      // open `/api/agent-workspaces**` poll without waiting on its interval.
      void mutate(isAgentSessionsKey);
    },
    [sessionId, paneStillShows, beginEndSessionConfirm, replaceConversation, closePane, resetPane, onConversationClosed, recordClosedConversation],
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
        // Deliberately no beginPaneAssign here: the user can still CANCEL
        // this dialog, in which case nothing about this pane actually
        // changes, and bumping the token regardless would invalidate a
        // pending mint/reopen for a close that never happened. If the user
        // DOES confirm, confirmEndSession tears down the whole workspace via
        // forgetWorkspace — at that point the existing paneStillLoading
        // shape-check already correctly detects this pane is gone, with no
        // token needed.
        beginEndSessionConfirm(paneId);
        return;
      }

      // Only reachable once a decision ACTUALLY commits to altering this
      // pane below — supersede any pending mint/reopen for it here, not
      // before the noop/end-session checks above (round-23 regression: a
      // stale close attempt that never actually altered anything must not
      // invalidate a genuinely in-flight mint for this pane, leaving it
      // stuck spinning forever for a close that never happened).
      beginPaneAssign(paneId);

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
      beginPaneAssign,
    ],
  );

  const confirmEndSession = useCallback(async () => {
    if (!pendingEndClose) return;
    // Snapshot for rollback, then assume success immediately: the grid and
    // sidebar row must not wait on the sandbox-kill round trip this DELETE
    // triggers server-side — that's the whole point of this being optimistic.
    // `forgetWorkspace` rather than `closePane` — this can fire with OTHER
    // panes still in the grid (a terminal, say, when the closed listing was
    // the session's last OPEN conversation rather than the grid's last pane),
    // and ending the session tears down every one of them at once, not just
    // the peeked pane's own.
    const { scope } = pendingEndClose;
    const workspaceSnapshot = useAgentWorkspaceStore.getState().workspaces[sessionId] ?? null;
    const sessionEntrySnapshot = sessionsData?.sessions.find((s) => s.sessionId === sessionId) ?? null;
    forgetWorkspace(sessionId);
    setPendingEndClose(null);
    // The bare top-level `mutate` import, matching every other call site in
    // this file — NOT `useSWRConfig()`'s scoped one, unlike `AgentsSidebar.tsx`.
    // Switching this specific spot to the scoped mutator (which does correctly
    // match `sessionsData`'s own cache) was tried and reverted: it makes
    // `sessionKnownToConversationsCache` (this component's own conversations-
    // cache-readiness flag) flip correctly mid-teardown, which re-triggers the
    // mount-time seed effect (`sessionKnownToConversationsCache` is one of its
    // deps) — and THAT effect has no guard against re-seeding a session whose
    // workspace was just deliberately forgotten, so it recreates a fresh
    // single-pane grid right behind this function's own optimistic drop. That
    // effect's missing guard is a real, pre-existing bug, but a different one
    // than this PR is about; fixing it here would conflate two unrelated
    // changes. No production `SWRConfig` provider exists anywhere in this app
    // (confirmed repo-wide), so the bare import already targets the one real
    // cache in practice — this is deferred as a known follow-up, not a
    // regression (review finding — chatgpt-codex-connector on PR #2318).
    forgetSessionInCache(mutate, sessionId);
    let hadOtherOpenConversations = false;
    try {
      const ended = await del<{ hadOtherOpenConversations?: boolean }>(
        `/api/agent-workspaces/${encodeURIComponent(sessionId)}`,
      );
      hadOtherOpenConversations = ended?.hadOtherOpenConversations ?? false;
    } catch (error) {
      // The optimistic assumption was wrong. Restore the grid and the
      // session's row LOCALLY from the snapshots above — a real revalidate
      // alone isn't enough: it rides the same network whose failure is
      // plausibly why the DELETE itself failed, so it could easily fail too
      // and leave the row missing indefinitely (review finding —
      // chatgpt-codex-connector on PR #2318). A revalidate still follows for
      // eventual reconciliation, but the restore itself doesn't depend on it.
      if (workspaceSnapshot) hydrateWorkspace(sessionId, workspaceSnapshot);
      if (sessionEntrySnapshot) restoreSessionInCache(mutate, sessionEntrySnapshot);
      void mutate(isSessionListingKey);
      console.error('Failed to end session:', error);
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      return;
    }
    // Only NOW — server-confirmed — is it safe to tear down the shell this
    // pane pointed at. Doing this earlier, alongside the optimistic grid
    // drop, would irreversibly kill a live shell before knowing the session
    // actually ended; a failed DELETE's rollback would then restore a
    // terminal pane pointed at a shell that no longer exists (review
    // finding — chatgpt-codex-connector on PR #2318).
    closeTerminalShell(scope);
    // Background reconcile only — the grid and sidebar are already right.
    void mutate(isSessionListingKey);
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
  }, [pendingEndClose, sessionId, sessionsData, forgetWorkspace, hydrateWorkspace, closeTerminalShell, onSessionEnded]);

  // Shared by cleanupOrphanedConversation's own post-DELETE recheck below and
  // handlePickHistoryConversation's rollback decision.
  const isConversationShownSomewhere = useCallback(
    (conversationId: string) => {
      const liveWorkspace = useAgentWorkspaceStore.getState().workspaces[sessionId];
      return (
        !!liveWorkspace &&
        panesOf(liveWorkspace).some((p) => p.scope?.kind === 'chat' && p.scope.targetId === conversationId)
      );
    },
    [sessionId],
  );

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
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
        // This DELETE can be delayed (a slow network) long enough for a
        // LATER, independent pick of this exact conversation to land in a
        // pane before it reaches the server — closing a listing that is now
        // visibly displayed. Re-check right after the delete resolves and
        // compensate by reopening it back rather than leaving the pane
        // pointed at a transcript that would 404 on send (review finding —
        // chatgpt-codex-connector on PR #2299, round 17).
        if (isConversationShownSomewhere(conversationId)) {
          await post(
            `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}/reopen`,
            {},
          );
          // The SAME race applies to this compensating reopen itself: the
          // pane that caused the check above to pass can move on to
          // something else before this call's own response arrives,
          // leaving the conversation orphaned again with nothing left to
          // notice. Re-check once more and, if so, clean up again — this
          // recurses rather than loops, so it naturally terminates the
          // moment the grid stops churning through this exact conversation
          // (review finding — chatgpt-codex-connector on PR #2299,
          // round 18).
          if (!isConversationShownSomewhere(conversationId)) {
            await cleanupOrphanedConversation(conversationId);
          }
        }
      } catch (error) {
        console.error('Failed to clean up an orphaned conversation:', error);
      }
    },
    [sessionId, isConversationShownSomewhere],
  );

  /**
   * After a switch or a "+" mint replaces what a pane shows, close the
   * conversation it replaced — the fix for panes silently accumulating stray
   * sidebar rows: switching an agent (or starting a new conversation)
   * closes the outgoing conversation's listing (unless another pane still
   * shows it, or it's already gone), instead of leaving it open forever. Runs
   * only AFTER the replacement lands; a failed mint never touches the prior
   * conversation. The 409 case is unreachable in the ordinary run: this
   * always mints/assigns the replacement FIRST, so the session has at least
   * that one open by the time this DELETE runs — the old conversation can
   * never be the server's last listing.
   */
  const closeReplacedConversation = useCallback(
    async (paneId: string, oldConversationId: string, newConversationId: string, newAgentPageId: string | null) => {
      // Shown in ANOTHER pane — nothing to close, that pane still needs it.
      if (isConversationShownSomewhere(oldConversationId)) return;
      // Never act on an unverified fact: an unresolved listing, or one that
      // has already resolved without this conversation in it (closed
      // elsewhere in the meantime), means there is nothing left here to
      // DELETE.
      if (closeDecisionListing === null) return;
      if (!closeDecisionListing.some((c) => c.conversationId === oldConversationId)) return;
      try {
        await del(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(oldConversationId)}`,
        );
      } catch (error) {
        console.error('Failed to close the replaced conversation:', error);
        return;
      }
      // Only tell the host if this pane still shows what THIS switch put
      // there — a later switch on the same pane, racing ahead of this
      // cleanup's own DELETE, already owns whatever the pane shows now.
      const liveWorkspace = useAgentWorkspaceStore.getState().workspaces[sessionId];
      const livePane = liveWorkspace ? panesOf(liveWorkspace).find((p) => p.id === paneId) : undefined;
      if (livePane?.scope?.kind === 'chat' && livePane.scope.targetId === newConversationId) {
        onConversationClosed?.({ conversationId: oldConversationId, next: newConversationId, nextAgentPageId: newAgentPageId });
      }
      recordClosedConversation(oldConversationId);
      void mutate(isAgentSessionsKey);
    },
    [sessionId, isConversationShownSomewhere, closeDecisionListing, onConversationClosed, recordClosedConversation],
  );

  // Keep the Agents CONSOLE's own selection in sync whenever a pane's
  // conversation changes to something the console didn't already know about
  // — mirroring what `useSpawnSession` already does after spawning a
  // session. Every call site that reassigns a pane's `targetId` to a
  // DIFFERENT conversation (a mint, or focusing one already open elsewhere)
  // needs this: without it, `selectedConversationId` keeps naming whatever
  // this pane USED to show, and a later remount's seeding effect tries to
  // re-open that stale id against a pane that no longer shows it —
  // reverting the swap or, once the eviction guard treats this pane as
  // protected, splitting a second pane open for it instead of recognizing
  // the swap as already done (caught in review). Centralized here, rather
  // than inlined at each call site, so the `chatContext` gate below lives in
  // exactly one place.
  //
  // Scoped to `chatContext === 'console'`: this component is also embedded
  // in a regular page's chat tab (`AgentPageView`, chatContext "page"),
  // whose `initialConversation` is driven by its own local state, not this
  // store — syncing there would both do nothing useful AND push a
  // `/dashboard/agents` URL via `history.pushState`, silently navigating a
  // page-embedded chat's user away to the Agents console (caught in review).
  const syncConsoleSelection = useCallback(
    (conversationId: string, agentPageId: string | null) => {
      if (chatContext !== 'console') return;
      selectConversation({ sessionId, conversationId, agentId: agentPageId });
    },
    [chatContext, selectConversation, sessionId],
  );

  const handlePickAgent = useCallback(
    async (paneId: string, agentPageId: string | null): Promise<boolean> => {
      // Also supersedes any pending `handlePickHistoryConversation` call for
      // this pane — a slow reopen resolving after the user has since minted
      // a different agent into this same pane must not overwrite it (review
      // finding — chatgpt-codex-connector on PR #2299). Captured (not
      // discarded) so THIS call can tell a genuinely stale completion of
      // ITSELF apart from a same-shaped sibling: two mints started back to
      // back before either settles install the SAME indistinguishable
      // loading scope, so `paneStillLoading`'s shape check alone can't tell
      // them apart — the older one's catch could restore over the newer
      // one's still-pending success, which then finds itself "superseded"
      // and cleans up its own just-created row (review finding — chatgpt-
      // codex-connector on PR #2299, round 14).
      const isCurrent = beginPaneAssign(paneId);
      const conversationId = createId();
      // Captured ONLY when no mint is already in flight for this pane — a
      // failed mint then restores THIS instead of always falling back to
      // the picker. For the normal "pick from an empty picker" call site
      // this is already null (restoring null IS today's reset-to-picker
      // behavior), but "New Conversation" picked from a pane's own History
      // tab starts from a pane already showing a real, working conversation
      // — losing that to a blank picker on a transient failure (session
      // full, network drop) is a real regression the user did not ask for
      // (review finding — chatgpt-codex-connector on PR #2299, round 13).
      // Reused (not re-captured) by any OVERLAPPING sibling mint for this
      // same pane — re-reading "the live scope now" on every call would see
      // an earlier sibling's own loading sentinel, not the true original
      // (review finding — chatgpt-codex-connector on PR #2299, round 15).
      if (!priorScopeBeforeMint.current.has(paneId)) {
        const liveWorkspaceAtStart = useAgentWorkspaceStore.getState().workspaces[sessionId];
        const capturedScope = liveWorkspaceAtStart
          ? (panesOf(liveWorkspaceAtStart).find((p) => p.id === paneId)?.scope ?? null)
          : null;
        // The pane's LOADING scope (targetId null) doesn't identify the
        // prior conversation, so a History-delete of it while this mint is
        // pending can't reset this pane the normal way — capture its
        // delete generation now and re-check before restoring, so a
        // since-deleted prior conversation is never resurrected onto a
        // pane whose sends would just 404 (review finding — chatgpt-codex-
        // connector on PR #2299, round 14).
        const capturedConversationId = capturedScope?.kind === 'chat' ? capturedScope.targetId : null;
        const deleteGenerationAtStart = capturedConversationId
          ? (historyDeleteGenerations.current.get(capturedConversationId) ?? 0)
          : 0;
        priorScopeBeforeMint.current.set(paneId, { scope: capturedScope, deleteGenerationAtStart });
      }
      pendingMintCounts.current.set(paneId, (pendingMintCounts.current.get(paneId) ?? 0) + 1);
      const { scope: priorScope, deleteGenerationAtStart: priorScopeDeleteGenerationAtStart } =
        priorScopeBeforeMint.current.get(paneId)!;
      const priorScopeConversationId = priorScope?.kind === 'chat' ? priorScope.targetId : null;
      // Exactly-once decrement regardless of exit path; clears the shared
      // capture only once every overlapping mint for this pane has settled.
      let mintSettled = false;
      const settleMint = () => {
        if (mintSettled) return;
        mintSettled = true;
        const next = (pendingMintCounts.current.get(paneId) ?? 1) - 1;
        if (next <= 0) {
          pendingMintCounts.current.delete(paneId);
          priorScopeBeforeMint.current.delete(paneId);
        } else {
          pendingMintCounts.current.set(paneId, next);
        }
      };
      // Bind first, render after: the pane goes to `loading` (kind set, target
      // null) while the mint is in flight — never a speculative surface.
      assignPane(sessionId, paneId, { kind: 'chat', name: 'New conversation', targetId: null, agentPageId });
      try {
        if (agentPageId === null) {
          // The ASSISTANT: no agent page, so the session-centric creator is
          // the path (page-agents has no page to hang this on).
          await post(`/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations`, {
            conversationId,
          });
        } else {
          await post(`/api/ai/page-agents/${encodeURIComponent(agentPageId)}/conversations`, {
            conversationId,
            sessionId,
          });
        }
        settleMint();
        if (!isCurrent() || !paneStillLoading(paneId, { kind: 'chat', agentPageId })) {
          // Either a NEWER call for this same pane superseded this one
          // (isCurrent false — round 14), or the pane closed mid-mint, or a
          // grid-last close already rebound it to another open listing
          // while this request was in flight. Either way, the row was
          // already created server-side — clean it up rather than leaving
          // an orphaned, unbound thread (or clobbering a newer assignment
          // with this now-abandoned mint's result).
          void cleanupOrphanedConversation(conversationId);
          return false;
        }
        const newScope: PaneScope = { kind: 'chat', name: 'New conversation', targetId: conversationId, agentPageId };
        // `priorScopeConversationId`, not "whatever the pane's scope is right
        // now" — the loading assign above already overwrote it, so only the
        // id captured BEFORE this mint sequence began still names the
        // conversation actually being replaced.
        assignPane(sessionId, paneId, newScope);
        syncConsoleSelection(conversationId, agentPageId);
        if (priorScopeConversationId !== null) {
          void closeReplacedConversation(paneId, priorScopeConversationId, conversationId, agentPageId);
        }
        // Local optimistic update for THIS component's own switch/close
        // decisions (instant, no network)...
        recordMintedConversation(conversationId, agentPageId);
        // ...and a broader revalidate covering every OTHER `/api/agent-workspaces**`
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
        return true;
      } catch (error) {
        settleMint();
        console.error('Failed to start a conversation in this pane:', error);
        toast.error('Could not start a conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        // Same rebind-survives rule as the success path above: a rejected
        // mint must not reset a pane a grid-last close already rebound to
        // something else while this request was in flight (caught in
        // review — the earlier fix only guarded the success path). Also
        // gated on `isCurrent()` (round 14) — a NEWER call for this same
        // pane already owns whatever happens to it now; this stale one must
        // not restore over that in-flight sibling.
        if (isCurrent() && paneStillLoading(paneId, { kind: 'chat', agentPageId })) {
          const priorScopeStillValid =
            !priorScopeConversationId ||
            (historyDeleteGenerations.current.get(priorScopeConversationId) ?? 0) ===
              priorScopeDeleteGenerationAtStart;
          if (priorScope && priorScopeStillValid) {
            assignPane(sessionId, paneId, priorScope);
          } else {
            resetPane(sessionId, paneId);
          }
        }
        return false;
      }
    },
    [
      assignPane,
      resetPane,
      sessionId,
      paneStillLoading,
      cleanupOrphanedConversation,
      closeReplacedConversation,
      recordMintedConversation,
      beginPaneAssign,
      syncConsoleSelection,
    ],
  );

  /**
   * A pane's own History tab picking a past conversation — assign it to THIS
   * pane, first either reopening it (bound to THIS session, closed) or
   * claiming it (never bound to ANY session — `claim-conversation-in-session.ts`)
   * into this session's listing, as needed. Only a conversation bound to a
   * DIFFERENT session is never subject to this session's cap/listing at
   * all — no server call, straight to `assignPane` (the same client-only
   * mechanism `openConversation`/`handleSwitchAgent`'s focus branch already
   * use to point a pane at an existing conversationId): claiming a
   * foreign-bound conversation would be a real rebind, which the claim route
   * refuses. Tool calls resolve their sandbox from the CONVERSATION ROW's
   * own persisted `sessionId` (`findSessionForConversation`, a fresh DB read
   * keyed only on `conversationId`), never from which pane grid happens to
   * display it (review question — chatgpt-codex-connector on PR #2299) — so
   * the claim above is what makes that lookup resolve to THIS session's
   * sandbox afterward, rather than the pane's chrome being purely cosmetic.
   *
   * Returns whether the pick actually landed — `false` on a failed reopen or
   * claim, so the caller (the pane's own tab-switch) can stay on History
   * rather than following a pick that never happened (review finding —
   * chatgpt-codex-connector on PR #2299).
   */
  const handlePickHistoryConversation = useCallback(
    async (
      paneId: string,
      agentPageId: string | null,
      conversation: { id: string; title: string | null; sessionId: string | null; isOwner: boolean },
    ): Promise<boolean> => {
      const isCurrent = beginPaneAssign(paneId);
      if (conversation.sessionId === sessionId) {
        const isShownSomewhere = () => isConversationShownSomewhere(conversation.id);
        pendingReopenCounts.current.set(conversation.id, (pendingReopenCounts.current.get(conversation.id) ?? 0) + 1);
        // Captured BEFORE the request starts — compared, never consumed, so
        // every concurrent reopen for this same conversationId independently
        // notices a delete that happened anywhere during its own flight
        // (round 9 review finding).
        const deleteGenerationAtStart = historyDeleteGenerations.current.get(conversation.id) ?? 0;
        // Exactly-once decrement regardless of which exit path below runs.
        // Returns the count still outstanding AFTER this one settles, so the
        // caller can tell whether it was the LAST one for this conversationId.
        let reopenSettled = false;
        const settleReopen = () => {
          if (reopenSettled) return pendingReopenCounts.current.get(conversation.id) ?? 0;
          reopenSettled = true;
          const next = (pendingReopenCounts.current.get(conversation.id) ?? 1) - 1;
          if (next <= 0) pendingReopenCounts.current.delete(conversation.id);
          else pendingReopenCounts.current.set(conversation.id, next);
          return next;
        };
        let reopenResult: { ok: boolean; alreadyOpen: boolean };
        try {
          reopenResult = await post<{ ok: boolean; alreadyOpen: boolean }>(
            `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversation.id)}/reopen`,
            {},
          );
        } catch (error) {
          const remaining = settleReopen();
          // I was the LAST outstanding reopen for this conversationId, and
          // an EARLIER (superseded) request already reopened it server-side
          // but deferred its own cleanup because I was still pending —
          // nothing else will ever revisit that now that I've failed
          // instead of landing it. Finish the job it punted on (round 9
          // review finding — chatgpt-codex-connector on PR #2299).
          if (remaining <= 0 && deferredReopenSuccess.current.delete(conversation.id) && !isShownSomewhere()) {
            void cleanupOrphanedConversation(conversation.id);
          }
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
        const remaining = settleReopen();
        if (!isCurrent()) {
          // The reopen SUCCEEDED server-side (closedInWorkspaceAt cleared, a
          // cap slot consumed) after a newer pick or agent mint already
          // superseded this one on the same pane — returning early without
          // undoing that leaves an invisible open listing occupying a slot
          // no pane shows, which can make a LATER reopen fail as "session
          // full" for no visible reason. Close it right back out, the same
          // way an orphaned mint is cleaned up above (review finding —
          // chatgpt-codex-connector on PR #2299).
          //
          // BUT only when it's genuinely orphaned: the same conversation
          // picked twice in quick succession can have the NEWER request's
          // reopen resolve first and legitimately land in a pane (this one
          // or another), with this now-stale request's reopen resolving
          // second. Unconditionally closing here would rip that just-
          // reopened, currently-visible conversation back out from under
          // whichever pane is showing it. Read live state across every pane
          // in the grid (not just this one) before deciding (review finding
          // — chatgpt-codex-connector on PR #2299).
          //
          // And only when THIS request actually transitioned the listing:
          // the reopen runtime returns `already_open` (folded into the same
          // `{ ok: true }` shape client-side used to see) when the
          // conversation was already open elsewhere (another pane/tab, or
          // an agent switch that left it open unshown) — this request never
          // opened it, so rolling it back would close a listing still in
          // use for a no-op this request didn't cause (review finding —
          // chatgpt-codex-connector on PR #2299, round 15).
          const shownSomewhere = isShownSomewhere();
          // The LAST settler for this conversationId is responsible for
          // finishing a SIBLING's deferred cleanup regardless of THIS
          // request's own outcome — an `alreadyOpen` no-op response still
          // needs to drain it if nothing else is left pending, or an
          // earlier request that genuinely transitioned the listing (and
          // deferred because this one was still in flight) leaks an
          // invisible open listing forever, since nothing else will ever
          // revisit it (review finding — chatgpt-codex-connector on PR
          // #2299, round 16).
          const hadDeferredSibling = remaining <= 0 && deferredReopenSuccess.current.delete(conversation.id);
          if (shownSomewhere) return false;
          if (hadDeferredSibling) {
            void cleanupOrphanedConversation(conversation.id);
            return false;
          }
          if (reopenResult.alreadyOpen) return false;
          if (remaining > 0) {
            // Something else is still reopening this same conversationId —
            // premature to clean up (that request might land it). Defer:
            // whichever reopen is the LAST to settle for this id is
            // responsible for finishing this check (round 9 review finding).
            deferredReopenSuccess.current.add(conversation.id);
          } else {
            void cleanupOrphanedConversation(conversation.id);
          }
          return false;
        }
        // I'm the one landing this — any deferred-cleanup marker left by an
        // earlier superseded request for this id is moot now.
        deferredReopenSuccess.current.delete(conversation.id);
        if ((historyDeleteGenerations.current.get(conversation.id) ?? 0) !== deleteGenerationAtStart) {
          // This reopen's HTTP round trip was still in flight when the SAME
          // conversation was deleted from History (possibly from a
          // different pane) — the reopen may have already committed
          // server-side before that delete landed, so assigning now would
          // bind this pane to a transcript that already 404s on send.
          // Treated like a superseded pick: no assignment, stay put (review
          // finding — chatgpt-codex-connector on PR #2299, round 8).
          return false;
        }
        // Instant-freshness nudge, same as every other listing-changing
        // action here — the sidebar's own open list otherwise lags until its
        // next poll.
        void mutate(isAgentSessionsKey);
      } else if (conversation.sessionId === null && conversation.isOwner) {
        // Genuinely never bound to ANY session, AND this pane's caller owns
        // it — claim it into this one so tool calls actually resolve a
        // sandbox afterward, instead of the old cosmetic assign-only path
        // (which left `findSessionForConversation` reading the same null
        // forever and denying every tool call as `no_session`). A History
        // list routinely also contains OTHER users' shared, still-unbound
        // conversations (`GET .../conversations`'s own `isShared` clause) —
        // claiming one of those would just 404 (the primitive's ownership
        // gate refuses it), stranding the pick on the History tab instead of
        // opening the shared transcript read-only the way it always has
        // (review finding — final adversarial pass on PR #2302). The
        // `!isOwner` case falls through to the same plain `assignPane` below
        // this whole if/else chain uses for an already-foreign-bound row.
        //
        // Needs the SAME in-flight-count + deferred-cleanup
        // coordination reopen uses above: the request that actually lands
        // the claim can go stale and see "nothing shows it yet" while a
        // LATER, now-current request for the same id is still in flight —
        // without coordinating, the stale request's cleanup can close the
        // listing right after the later request already decided nothing
        // needed cleaning up, leaving a pane displaying a conversation the
        // session lists as closed (review finding — chatgpt-codex-connector
        // on PR #2299, claim analog of the same round-9/15/16 races).
        const isShownSomewhere = () => isConversationShownSomewhere(conversation.id);
        pendingClaimCounts.current.set(conversation.id, (pendingClaimCounts.current.get(conversation.id) ?? 0) + 1);
        const deleteGenerationAtStart = historyDeleteGenerations.current.get(conversation.id) ?? 0;
        let claimSettled = false;
        const settleClaim = () => {
          if (claimSettled) return pendingClaimCounts.current.get(conversation.id) ?? 0;
          claimSettled = true;
          const next = (pendingClaimCounts.current.get(conversation.id) ?? 1) - 1;
          if (next <= 0) pendingClaimCounts.current.delete(conversation.id);
          else pendingClaimCounts.current.set(conversation.id, next);
          return next;
        };
        let claimResult: { ok: boolean; alreadyInSession: boolean };
        try {
          claimResult = await post<{ ok: boolean; alreadyInSession: boolean }>(
            `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversation.id)}/claim`,
            {},
          );
        } catch (error) {
          const remaining = settleClaim();
          if (remaining <= 0 && deferredClaimSuccess.current.delete(conversation.id) && !isShownSomewhere()) {
            void cleanupOrphanedConversation(conversation.id);
          }
          if (!isCurrent()) return false;
          console.error('Failed to move this conversation into the session:', error);
          toast.error('Could not move this conversation into the session', {
            description: error instanceof Error ? error.message : 'Please try again.',
          });
          return false;
        }
        const remaining = settleClaim();
        if (!isCurrent()) {
          // The BINDING itself is permanent and can never be rolled back
          // (claiming is not a rebind primitive) — only the open-listing
          // SLOT it just consumed can be, and only when this request
          // genuinely transitioned it, nothing else is already showing it,
          // AND nothing else is still pending for the same id (which might
          // yet land it) — same non-destructive-rollback rule the reopen
          // branch above uses.
          const shownSomewhere = isShownSomewhere();
          const hadDeferredSibling = remaining <= 0 && deferredClaimSuccess.current.delete(conversation.id);
          if (shownSomewhere) return false;
          if (hadDeferredSibling) {
            void cleanupOrphanedConversation(conversation.id);
            return false;
          }
          if (claimResult.alreadyInSession) return false;
          if (remaining > 0) {
            // Something else is still claiming this same conversationId —
            // premature to clean up (that request might land it). Defer:
            // whichever claim is the LAST to settle for this id is
            // responsible for finishing this check.
            deferredClaimSuccess.current.add(conversation.id);
          } else {
            void cleanupOrphanedConversation(conversation.id);
          }
          return false;
        }
        // I'm the one landing this — any deferred-cleanup marker left by an
        // earlier superseded request for this id is moot now.
        deferredClaimSuccess.current.delete(conversation.id);
        if ((historyDeleteGenerations.current.get(conversation.id) ?? 0) !== deleteGenerationAtStart) {
          // Same staleness hazard the reopen branch guards against above: a
          // History delete landed mid-flight, so assigning now would bind
          // this pane to a transcript that already 404s on send.
          return false;
        }
        // Same local-optimistic-write-before-revalidate discipline
        // `handlePickAgent`'s own mint uses (see its comment above): without
        // this, closing this pane before the `mutate` below resolves makes
        // `decideClosePane` see the just-claimed conversation as not
        // open-listed yet and take the pure layout-close path, orphaning it
        // — holding a cap slot with no pane left to retry the close from
        // (review finding — final adversarial pass on PR #2302). Only when
        // THIS request actually transitioned the listing — `alreadyInSession`
        // means some other request already did (or it was never unbound to
        // begin with), and `recordMintedConversation` has no id-based dedupe,
        // so calling it again would prepend a second, duplicate row for the
        // same conversationId into the local cache (self-review finding).
        if (!claimResult.alreadyInSession) recordMintedConversation(conversation.id, agentPageId);
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
    [sessionId, assignPane, selectPane, beginPaneAssign, cleanupOrphanedConversation, isConversationShownSomewhere, recordMintedConversation],
  );

  /**
   * A pane's History tab deleting a conversation (`softDeleteConversation`
   * deactivates the CANONICAL row) — every pane in THIS grid still showing
   * that id, whichever pane's History tab the delete came from, is left with
   * a dead transcript: staying on it would render nothing sendable (the row
   * now 404s per the send-route's own isActive guard) with no obvious way
   * out. Reset each affected pane to the picker — the simplest, safe
   * recovery; the user explicitly picks what's next rather than a guessed
   * replacement.
   */
  const handleHistoryDeleteConversation = useCallback(
    (deletedConversationId: string) => {
      // Bumped unconditionally (not just when a pane is currently affected
      // below): a History pick's reopen for this exact id can be mid-flight
      // right now, possibly from more than one pane at once, having already
      // committed server-side, with its completion(s) still to come — each
      // one independently compares its own captured start value against
      // this counter before assigning (review finding — chatgpt-codex-
      // connector on PR #2299, rounds 8-9).
      historyDeleteGenerations.current.set(
        deletedConversationId,
        (historyDeleteGenerations.current.get(deletedConversationId) ?? 0) + 1,
      );
      // Instant-freshness nudge, unconditional — the canonical row is gone
      // from the session's listing regardless of whether any pane in THIS
      // grid happens to be showing it right now. Scoping this to "only when
      // a pane was affected" left every OTHER consumer of the cached
      // listing (handleSwitchAgent's focus branch, a close decision's
      // fallback) trusting a stale row for up to the poll interval —
      // binding a pane to a transcript that already 404s on send (review
      // finding — chatgpt-codex-connector on PR #2299, round 15).
      void mutate(isAgentSessionsKey);
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
    },
    [sessionId, resetPane],
  );

  // The pane bar selector's switch — a two-way decision (see
  // select-pane-agent.ts): already open elsewhere in the session
  // (focus-existing — reuse that conversation as THIS pane's content, no
  // mint needed), or not (mint). Confirmed: no cross-pane dedup — reusing an
  // elsewhere-open conversation never jumps focus to the OTHER pane showing
  // it, it shows up here too. Either way, replacing this pane's content
  // closes the OUTGOING conversation's listing (via
  // `closeReplacedConversation`, shared with the mint path) — the fix for
  // panes silently accumulating stray sidebar rows: switching used to leave
  // the old conversation open forever.
  const handleSwitchAgent = useCallback(
    (paneId: string, currentAgentPageId: string | null, nextAgentPageId: string | null) => {
      if (!workspace) return;
      const pane = panesOf(workspace).find((p) => p.id === paneId);
      const decision = selectPaneAgent({
        sessionConversations,
        selectedAgentPageId: nextAgentPageId,
        currentAgentPageId,
      });
      if (decision.action === 'noop') return;
      if (decision.action === 'focus-existing') {
        const oldTargetId = pane?.scope?.kind === 'chat' ? pane.scope.targetId : null;
        assignPane(sessionId, paneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: decision.conversationId,
          agentPageId: nextAgentPageId,
        });
        syncConsoleSelection(decision.conversationId, nextAgentPageId);
        if (oldTargetId !== null) {
          void closeReplacedConversation(paneId, oldTargetId, decision.conversationId, nextAgentPageId);
        }
        return;
      }
      void handlePickAgent(paneId, nextAgentPageId);
    },
    [
      workspace,
      sessionConversations,
      sessionId,
      assignPane,
      closeReplacedConversation,
      handlePickAgent,
      syncConsoleSelection,
    ],
  );

  const handlePickShell = useCallback(
    async (paneId: string) => {
      assignPane(sessionId, paneId, { kind: 'terminal', name: 'shell', targetId: null, agentPageId: null });
      try {
        const { shell } = await post<{ shell: { shellId: string; name: string } }>(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells`,
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

  // A page binding addresses an existing page directly — unlike a
  // conversation or a shell, there is nothing to mint server-side, so this is
  // a single synchronous assignment (no loading state, no rollback path).
  const handlePickPage = useCallback(
    (paneId: string, pageId: string, title: string) => {
      assignPane(sessionId, paneId, { kind: 'page', name: title, targetId: pageId, agentPageId: null });
    },
    [assignPane, sessionId],
  );

  if (!workspace) {
    // With a conversation to seed, the openConversation effect creates the
    // grid on the next tick — the spinner is a single-frame state. A
    // session-only selection has nothing to seed locally; until
    // `useWorkspaceServerSync`'s hydration seats a saved grid (if one
    // exists), point at the sidebar rather than spin forever.
    return (
      <div className="flex h-full items-center justify-center">
        {initialConversation ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <p className="text-sm text-muted-foreground">
            This session&apos;s conversations are listed under it in the sidebar.
          </p>
        )}
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
          hostConversationId={hostConversationId}
          isReadOnly={isReadOnly}
          onSelectAgent={(nextAgentPageId) => handleSwitchAgent(pane.id, pane.scope!.agentPageId, nextAgentPageId)}
          onSelectPane={() => selectPane(sessionId, pane.id)}
          onSplitRight={() => splitRight(sessionId, pane.id)}
          onSplitDown={() => splitDown(sessionId, pane.id)}
          onClose={() => handleClosePane(pane.id)}
          // The "+" chip and History's own "New Conversation" button are now
          // the identical call — both start a fresh conversation with this
          // pane's current agent, replacing what's showing (still reachable
          // afterward via History, unless nothing else shows it).
          onCreateNewFromHistory={() => handlePickAgent(pane.id, pane.scope!.agentPageId)}
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
              driveId={driveId}
              isLoading={agentsLoading}
              canRunSandbox={canRunSandbox}
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
              onPickPage={(pageId, title) => handlePickPage(pane.id, pageId, title)}
            />
          ) : surface.surface === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : surface.surface === 'page' ? (
            <PagePaneView pageId={surface.pageId} />
          ) : surface.surface === 'terminal' ? (
            <Shell key={surface.shellId} shellId={surface.shellId} name={pane.scope?.name} />
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
  hostConversationId,
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
  /** The hosting page's own current conversation — see `AgentPanesProps.hostConversationId`'s own doc. */
  hostConversationId?: string | null;
  isReadOnly: boolean;
  onSelectAgent: (agentPageId: string | null) => void;
  onSelectPane: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
  /**
   * Starts a new conversation with this pane's current agent, replacing
   * whatever it shows — the "+" chip's action, and identically what
   * History's own "New Conversation" button triggers. Resolves to whether it
   * actually landed — false on a failed create.
   */
  onCreateNewFromHistory: () => Promise<boolean>;
  /** Resolves to whether the pick actually landed — false on a failed reopen. */
  onPickHistoryConversation: (conversation: { id: string; title: string | null; sessionId: string | null; isOwner: boolean }) => Promise<boolean>;
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
  // `handleCreateNewFromHistory`'s OWN internal guard — just the stream
  // check, deliberately NOT `conversationsReady`: that flag only matters for
  // a decision this action never makes (whether an agent already has a
  // thread, to focus instead of mint); History's whole point is "start fresh
  // regardless," so gating it on the switch-decision's own readiness would
  // block a working action for an unrelated reason. Also deliberately NOT
  // mid-mint: a second mint racing an in-flight one is a supported, harmless
  // double-click race (`handlePickAgent`'s own token/counter bookkeeping
  // exists precisely to let it land safely). Blocking a live stream IS
  // required either way — replacing the pane would yank a still-arriving
  // response (and any in-flight tool work) out from under itself, with no
  // way back (review finding — chatgpt-codex-connector on PR #2308).
  const blockedByActiveStream = activeStream !== undefined;
  // The "+" chip's own `disabled` prop: the stream guard above, plus its
  // pre-existing `!conversationsReady` gate (unrelated to streams, kept as-is).
  const disabledNewConversation = blockedByActiveStream || !conversationsReady;

  const [activeTab, setActiveTab] = useState<PaneChatTab>('chat');

  // A pane's agent can change under it (the AISelector switch) without
  // remounting this component. Settings belongs to the OLD agent — showing
  // it (or leaving `activeTab: 'settings'` set) after switching to a
  // DIFFERENT agent presents that agent's config as if requested, and
  // switching to the Assistant (no Settings tab at all) leaves the body on
  // its final "not agentPageId or no agent" branch, a spinner that never
  // resolves since neither condition can ever become true again for this
  // scope (review finding — coderabbitai on PR #2299).
  //
  // This pane's identity collapsing to `hostConversationId` (see `PaneBar`'s
  // `identity` below) removes the Chat/History/Settings tab strip entirely —
  // staying on History/Settings with no strip left to switch back from
  // would strand the pane exactly like the agent-switch case above (review
  // finding — final adversarial pass on PR #2302).
  const isHostIdentity = conversationId !== null && conversationId === hostConversationId;
  useEffect(() => {
    setActiveTab('chat');
  }, [scope.agentPageId, isHostIdentity]);

  const {
    conversations,
    isLoading: conversationsLoading,
    deleteConversation,
    refreshConversations,
  } = useConversations({
    agentId: scope.agentPageId,
    currentConversationId: conversationId,
    // Only fetched while History is actually showing — same lazy-load
    // discipline `AgentPageView`'s own History tab uses.
    enabled: activeTab === 'history',
  });

  const { config: agentConfig, setConfig: setAgentConfig, revalidate: revalidateAgentConfig } = useAgentConfig(scope.agentPageId);
  const {
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings(scope.agentPageId ? { pageId: scope.agentPageId } : {});
  // clean/dirty/saving/saved — same state machine as AgentPageView's Save
  // Settings button, scaled down for this 30px pane bar. `agentConfig ===
  // null` folds into "clean": PageAgentSettingsTab registers `submitForm`
  // before its own config-loaded check returns, and its form defaults
  // contain an EMPTY prompt/tool list, so this button must stay inert (not
  // just "clean"-styled) until real config has loaded and been edited.
  const {
    saveState: settingsSaveState,
    setIsSaving: setIsSettingsSaving,
    setIsDirty: setIsSettingsDirty,
    handleSaved: handleSettingsSaved,
  } = useAgentSettingsSaveState({ isConfigLoaded: agentConfig !== null });
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
        isOwner: picked?.isOwner ?? false,
      });
      if (landed) {
        setActiveTab('chat');
        // A successful pick of a never-bound conversation just claimed it
        // into this session — this pane's own History list still holds the
        // stale `sessionId: null` for that row until refreshed, which would
        // make an immediate re-pick attempt a redundant claim.
        refreshConversations();
      }
    },
    [conversations, onPickHistoryConversation, refreshConversations],
  );

  const handleCreateNewFromHistory = useCallback(async () => {
    // Blocks only on an active stream (see `blockedByActiveStream`'s own
    // doc) — History's "New Conversation" button reaches this exact same
    // action but has no button-level guard of its own, so it's checked here
    // once instead of threading a new prop through the shared
    // `PageAgentHistoryTab` (review finding — chatgpt-codex-connector on
    // PR #2308).
    if (blockedByActiveStream) return;
    // Only follow to Chat once the mint actually landed — same discipline
    // as handleSelectHistoryConversation above. A failed create (session
    // full, permission changed, network drop) now restores this pane's
    // PRIOR scope internally (handlePickAgent), so staying on History here
    // shows that restored, still-working conversation underneath rather
    // than switching to a blank/lost pane (review finding — chatgpt-codex-
    // connector on PR #2299, round 13).
    const landed = await onCreateNewFromHistory();
    if (landed) setActiveTab('chat');
  }, [blockedByActiveStream, onCreateNewFromHistory]);

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
          isHostIdentity ? (
            // This pane is showing the SAME conversation the hosting AI_CHAT
            // page's own header already identifies (Chat/History/Settings
            // pills, agent name) — a second selector + tab-strip here would
            // just be duplicate chrome for the identical thing. Matched by
            // CONVERSATION, not agent: a split pane pointed at the same
            // agent but a DIFFERENT conversation is still something the
            // page's own header isn't showing, so it keeps its full
            // selector below. Drop to the same plain, non-interactive label
            // the other pane kinds (terminal, page, picker) already use;
            // split/close (below, unaffected) is still this pane bar's job.
            // The "+" chip in `actions` still works regardless, unaffected
            // by this branch.
            <PaneSessionIdentity name={agent?.title ?? 'Agent'} />
          ) : (
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
          )
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
                // Only clickable once there's something to save — also the
                // guard against clicking before agentConfig arrives (see
                // settingsSaveState above; review finding — chatgpt-codex-
                // connector on PR #2299).
                disabled={settingsSaveState !== 'dirty'}
                // The state change (Saving.../Saved) is now the ONLY save
                // confirmation — there's no toast to announce it anymore,
                // so screen readers need this to catch it.
                aria-live="polite"
                aria-atomic="true"
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:pointer-events-none',
                  settingsSaveState === 'clean' && 'text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50',
                  settingsSaveState === 'dirty' && 'text-warning hover:bg-warning/10',
                  settingsSaveState === 'saving' && 'text-warning',
                  settingsSaveState === 'saved' && 'text-success',
                )}
              >
                {settingsSaveState === 'saving' ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : settingsSaveState === 'saved' ? (
                  <Check className="size-3 animate-in zoom-in-50 fade-in-0 duration-200" aria-hidden="true" />
                ) : (
                  <span className="relative inline-flex">
                    <Save className="size-3" aria-hidden="true" />
                    {settingsSaveState === 'dirty' && (
                      <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-1 animate-pulse rounded-full bg-warning" />
                    )}
                  </span>
                )}
                {settingsSaveState === 'saved' ? 'Saved' : 'Save'}
              </button>
            )}
            <button
              type="button"
              aria-label="Start a new conversation"
              title="Start a new conversation"
              disabled={disabledNewConversation}
              onClick={(e) => {
                e.stopPropagation();
                void handleCreateNewFromHistory();
              }}
              className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
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
              sessionId={sessionId}
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


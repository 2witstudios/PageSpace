'use client';

/**
 * AgentPanes — the container that turns the pure pane pieces into a working
 * grid for ONE workspace.
 *
 * Composition per pane, via `resolvePaneSurface`:
 *
 * ```
 * SessionPanes (layout only, surfaces injected)
 *  └─ pane: PaneBar (identity + split/close) over
 *      picker   → PanePicker      (unbound — choose an agent, a shell, a
 *                                  page, or reattach a shell already running)
 *      chat     → PaneChat        (a conversation IN this workspace)
 *      terminal → Shell           (a PTY on this workspace's sandbox)
 *      page     → PagePaneView    (a PageSpace page, rendered with the same
 *                                  view the main content area uses)
 *      loading  → spinner         (unbound, with a mint in flight FROM THIS
 *                                  BROWSER — never a speculative terminal)
 * ```
 *
 * The container owns ALL the IO a pick triggers — minting a conversation into
 * THIS workspace, opening or reattaching a shell on it — and writes the result
 * through the store's node commands. Sandbox identity is never threaded
 * anywhere: every conversation and shell here resolves the workspace's one
 * sandbox by construction (the Sprite key folds the workspace id).
 *
 * **THREE THINGS THE NODE MODEL DELETED FROM THIS FILE, and each was a source of
 * bugs rather than a feature:**
 *
 *  - **The mount-time grid seed.** There was an `ensureWorkspace` verb, and a
 *    spinner for the frame before it landed. A workspace's root is now minted
 *    server-side by whatever write first needs one (`seedRoot`), so there is
 *    nothing for a browser to create and no moment where the create landed and
 *    the bind did not — the state production is full of.
 *  - **The loading REBIND.** A mint used to set the pane to `{kind, targetId:
 *    null}` and then to the real target. A `PaneTarget` cannot be half-bound, so
 *    the pane simply stays unbound and this component remembers that it asked;
 *    with it went `priorScopeBeforeMint`, the reference-counted capture that
 *    existed only to restore a sentinel a failed mint had installed.
 *  - **Ending the workspace on the last close.** Closing the last pane leaves an
 *    empty grid. Ending is a lifecycle act, and it is still here — behind its
 *    own confirm, reachable from the server's own `last_conversation` 409 —
 *    but it is no longer something a close can stumble into.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { Check, History, Loader2, MessageSquare, Plus, Save, Settings } from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { mutate } from 'swr';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { fetchWithAuth, post, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useWorkspaceLayoutSync } from '@/stores/agent-workspace/useWorkspaceLayoutSync';
import {
  indexTargets,
  lookupTarget,
  nodeShowing,
  paneNodesOf,
  titleOf,
} from '@/stores/agent-workspace/workspace-tree-view';
import { findNode, type PaneNode } from '@pagespace/lib/agent-workspaces/workspace-node';
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
import { resolvePaneSurface } from './pane-surface';
import { selectPaneAgent } from './select-pane-agent';
import { decideClosePane } from './close-pane';
import {
  agentWorkspacesKey,
  isAgentWorkspacesKey,
  isWorkspaceListingKey,
  forgetWorkspaceInCache,
  restoreWorkspaceInCache,
  type SessionConversationSummary,
  type SessionListEntry,
} from './workspace-conversations';
import PaneChat from './PaneChat';
import PagePaneView from './PagePaneView';
import Shell from '../shell/Shell';

export interface AgentPanesProps {
  /**
   * The workspace this grid belongs to — `agent_workspaces.id`, the value the
   * DTO calls `workspaceId`.
   *
   * IT IS NOT `conversations.sessionId`, the column Phase 5 deprecated. The name
   * here is the pre-rename spelling and has not been swept yet (see
   * `docs/2.0-architecture/agent-sessions.md` §4, "NOT renamed, and NOT frozen
   * either"), which is why lines below read `session.workspaceId === sessionId`
   * — a workspace id compared against a workspace id, however that scans.
   */
  sessionId: string;
  /** The workspace's drive — where the picker's agent list comes from. Null for a global-assistant workspace. */
  driveId: string | null;
  /**
   * The conversation the host wants shown. Selection IS an instruction: this
   * focuses the node already showing it, or places it when nothing does. Null
   * for a workspace-only selection (a page/terminal row in the sidebar, a
   * conversation-less deep link) — there is nothing to show, and the grid
   * renders whatever the tree holds.
   */
  initialConversation: { conversationId: string; agentPageId: string | null; name: string } | null;
  /** Fired after the workspace was ended — the host owns what renders next. */
  onSessionEnded?: () => void;
  /**
   * Fired after a conversation's LISTING closed. `next` is always `null` now:
   * closing never rebinds a pane to a replacement, because the grid is allowed
   * to be empty. The shape is kept so a host tracking "current conversation"
   * independently of the tree can decide for itself what a closed conversation
   * means for whatever it is showing elsewhere.
   */
  onConversationClosed?: (event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => void;
  /**
   * Which message renderer chat panes use — the agent PAGE hosts the grid with
   * the full renderer, the console with the compact one. Layout is identical.
   */
  chatContext?: 'page' | 'console';
  /**
   * The conversation the HOSTING AI_CHAT page's own header is currently showing,
   * when this is that page's own embedded grid — the one pane bound to exactly
   * this conversation is displaying the same thing the page's own
   * selector/Chat/History/Settings chrome already identifies, so its pane bar
   * drops to a plain label instead. Deliberately keyed by CONVERSATION, not
   * agent: a split pane the user pointed at the same agent but a DIFFERENT
   * conversation is still a distinct thing the page's header isn't showing.
   */
  hostConversationId?: string | null;
  /** Read-only viewers get history but no send/edit/delete/retry in any chat pane. */
  isReadOnly?: boolean;
}

/** A mint this browser has in flight, keyed by the node that asked for it. */
interface PendingMint {
  kind: 'chat' | 'terminal';
  /** For a chat mint: which agent. `null` is the Assistant, which is not "no agent". */
  agentPageId: string | null;
}

async function shellsFetcher(url: string): Promise<{ shells: ReattachableShell[] }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to list shells (${response.status})`);
  return response.json();
}

/**
 * The same bulk listing the sidebar polls — SWR dedupes an identical key, so
 * mounting both costs one request, not two. Shared by every pure decision here:
 * the switch decision (`selectPaneAgent`) and the close decision
 * (`decideClosePane`, which needs it to know whether this node's thread still
 * has a listing to close).
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
  // THE workspace object, selected whole. Never a filter inlined into the
  // selector: that returns a fresh array per call, `Object.is` says it changed,
  // and the subscription loops. Every derivation below is a `useMemo` over this.
  const tree = useAgentWorkspaceStore((state) => state.workspaces[sessionId]);
  const openConversation = useAgentWorkspaceStore((state) => state.openConversation);
  const splitPane = useAgentWorkspaceStore((state) => state.splitPane);
  const closePane = useAgentWorkspaceStore((state) => state.closePane);
  const selectNode = useAgentWorkspaceStore((state) => state.selectNode);
  const bindPane = useAgentWorkspaceStore((state) => state.bindPane);
  const unbindPane = useAgentWorkspaceStore((state) => state.unbindPane);
  const forgetWorkspace = useAgentWorkspaceStore((state) => state.forgetWorkspace);
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);

  const nodes = useMemo(() => tree?.nodes ?? [], [tree]);
  const targetIndex = useMemo(() => indexTargets(tree?.targets ?? []), [tree]);

  // Whether THIS workspace's payer (not the viewing user) is sandbox-eligible —
  // server-resolved (the client only knows its own tier, the wrong axis for a
  // shared drive). Defaults to true while unresolved: a workspace that has
  // ALREADY provisioned a Sprite is proof enough that it was eligible, and the
  // picker's Shell/reattach buttons mustn't flash disabled on every mount.
  const { data: sessionRecordData } = useSessionRecord(sessionId);
  const canRunSandbox = sessionRecordData?.sandboxEligible ?? true;

  // The tree is SERVER-AUTHORITATIVE: the store posts each edit as its own
  // write-set, and this hook supplies the other direction — the mount-time
  // snapshot and the `session:<id>` room that keeps it live. Unconditional,
  // including for read-only viewers: reading is exactly what they do, and the
  // server snapshot is the only place their layout can come from.
  useWorkspaceLayoutSync(sessionId);

  /**
   * Mints this browser has in flight, by node id.
   *
   * The durable tree cannot hold this — a pane is bound or it is not — and that
   * is right: "I clicked an agent nine hundred milliseconds ago" is a fact about
   * this tab, not about the workspace. It renders as the pane's spinner and
   * gates the completion handlers.
   */
  const [pendingMints, setPendingMints] = useState<Record<string, PendingMint>>({});
  const beginMint = useCallback((nodeId: string, mint: PendingMint) => {
    setPendingMints((current) => ({ ...current, [nodeId]: mint }));
  }, []);
  const endMint = useCallback((nodeId: string) => {
    setPendingMints((current) => {
      if (!(nodeId in current)) return current;
      const { [nodeId]: _done, ...rest } = current;
      return rest;
    });
  }, []);
  // Read through a ref rather than the state value: every completion handler
  // below runs after an await, and the closure it captured is a render old.
  const pendingMintsRef = useRef(pendingMints);
  pendingMintsRef.current = pendingMints;

  /**
   * Is `nodeId` STILL an unbound node ON THE GRID, waiting on this mint?
   *
   * Not merely present, and the grid clause is the part the node model made
   * necessary. Closing a pane no longer destroys it — it PARKS it — so a node
   * whose pane the user closed mid-mint still exists, still unbound, and a
   * check for existence alone would land the result in a rectangle that is no
   * longer on screen. "The pane is still there waiting" means on the grid.
   */
  const stillMinting = useCallback(
    (nodeId: string, mint: PendingMint) => {
      const outstanding = pendingMintsRef.current[nodeId];
      if (!outstanding || outstanding.kind !== mint.kind || outstanding.agentPageId !== mint.agentPageId) return false;
      const node = findNode(useAgentWorkspaceStore.getState().workspaces[sessionId]?.nodes ?? [], nodeId);
      return node !== undefined && node.nodeType === 'pane' && node.target === null && node.parentId !== null;
    },
    [sessionId],
  );

  // Say something when the write queue throws the user's work away.
  //
  // The store abandons `pending` on a non-409 4xx (most often the target gate
  // refusing a binding), after the transport fails its attempt budget, and when
  // new server truth arrives that a local edit can no longer be rebased onto.
  // That is the right behaviour — but done silently it reads as the app ignoring
  // a split the user just made. Keyed on `at` so each transition toasts exactly
  // once rather than on every render.
  const queueError = useAgentWorkspaceStore((state) => state.queueErrors[sessionId]);
  const toastedQueueErrorAt = useRef<number | null>(null);
  useEffect(() => {
    if (!queueError || toastedQueueErrorAt.current === queueError.at) return;
    toastedQueueErrorAt.current = queueError.at;
    if (queueError.reason === 'refused') {
      toast.error("That can't be shown in this workspace.", {
        description: 'The layout has been put back to what the server has.',
      });
    } else if (queueError.reason === 'abandoned') {
      toast.error('Your layout change could not be saved.', {
        description: 'Showing the last version the server has.',
      });
    } else if (queueError.reason === 'superseded') {
      toast.error('That pane changed somewhere else while you were editing it.', {
        description: 'Your change was dropped; showing what the server has.',
      });
    } else {
      toast.error('This layout may be out of date.', {
        description: 'It could not be re-read — reload to be sure of it.',
      });
    }
  }, [queueError]);

  // The latest "point this node at conversation X" request per node — bumped by
  // every such request (a History pick, an agent mint) so an OLDER one's async
  // completion can detect it has been superseded and skip applying its
  // now-stale result.
  const paneAssignTokens = useRef(new Map<string, number>());
  const beginPaneAssign = useCallback((nodeId: string) => {
    const token = (paneAssignTokens.current.get(nodeId) ?? 0) + 1;
    paneAssignTokens.current.set(nodeId, token);
    return () => paneAssignTokens.current.get(nodeId) === token;
  }, []);

  // Races the per-node token can't catch, since it is scoped per NODE while
  // these are scoped per CONVERSATION:
  //
  // 1. The SAME conversation picked twice can have the OLDER reopen resolve
  //    first while the NEWER one is still in flight — at that instant no node
  //    shows it yet, so the older (stale) request's "is anyone showing this?"
  //    check reads false-orphaned and closes the conversation the newer request
  //    is about to legitimately land. Tracked as an in-flight count per
  //    conversationId; the rollback only fires once nothing else is still
  //    reopening the same id. `deferredReopenSuccess` covers the case where the
  //    LAST settler is the one that FAILS, so nothing is left to finish an
  //    earlier request's deferred cleanup.
  const pendingReopenCounts = useRef(new Map<string, number>());
  const deferredReopenSuccess = useRef(new Set<string>());
  // The same coordination for the CLAIM branch: a never-bound row picked twice
  // rapidly races exactly like a reopen does. A parallel pair rather than a
  // rename, so the two operations do not share one key namespace for no benefit.
  const pendingClaimCounts = useRef(new Map<string, number>());
  const deferredClaimSuccess = useRef(new Set<string>());
  // 2. A reopen can commit server-side, then have its OWN response delayed long
  //    enough for the SAME conversation to be deleted from History before the
  //    reopen's completion shows it — landing a pane on a transcript that
  //    already 404s on send. A per-conversationId generation counter, compared
  //    and never consumed, so every one of several concurrent completions
  //    notices the delete independently.
  const historyDeleteGenerations = useRef(new Map<string, number>());

  // The picker's agent list. A drive workspace offers only that drive's agents;
  // a global-assistant workspace (driveId null) has no home drive to filter by,
  // so it offers every agent the caller can access.
  const { allAgents, isLoading: agentsLoading } = usePageAgents(driveId ?? undefined);
  const pickableAgents: PickableAgent[] = useMemo(
    () =>
      (allAgents ?? [])
        .filter((agent) => driveId === null || agent.driveId === driveId)
        .map((agent) => ({
          id: agent.id,
          title: agent.title ?? 'Agent',
          // Only carried for a global workspace's cross-drive list.
          driveName: driveId === null ? agent.driveName : undefined,
        })),
    [allAgents, driveId],
  );

  // This workspace's shells, so the picker can offer to REATTACH one instead of
  // only spawning new — otherwise closing a terminal pane orphans its shell with
  // no way back short of the sidebar's count.
  const { data: shellsData } = useSWR(
    `/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells`,
    shellsFetcher,
    { revalidateOnFocus: false, refreshInterval: 15_000 },
  );
  const reattachableShells: ReattachableShell[] = useMemo(() => {
    // A shell bound to a PARKED node is still bound — it has a viewer waiting
    // one click away — so the reattach list reads every pane, not just the grid.
    const bound = new Set(
      paneNodesOf(nodes)
        .filter((node) => node.target?.kind === 'terminal')
        .map((node) => node.target?.id),
    );
    return (shellsData?.shells ?? []).filter((shell) => !bound.has(shell.shellId));
  }, [shellsData, nodes]);

  // This workspace's open conversation listings — shared by the pane bar
  // selector's SWITCH decision and the grid's CLOSE decision.
  const { data: sessionsData, mutate: mutateSessionConversations } = useSWR(
    agentWorkspacesKey(driveId),
    sessionConversationsFetcher,
    {
      revalidateOnFocus: false,
      // BACKSTOP, not the mechanism. `session-directory-listener.ts` applies
      // `conversation:*` and `session:*` to this exact cache the moment they
      // happen, so the poll only catches a broadcast lost entirely.
      refreshInterval: 120_000,
    },
  );
  const currentSessionConversationsEntry = useMemo(
    () => (sessionsData?.sessions ?? []).find((session) => session.workspaceId === sessionId),
    [sessionsData, sessionId],
  );
  const sessionConversations: SessionConversationSummary[] = useMemo(
    () => currentSessionConversationsEntry?.conversations ?? [],
    [currentSessionConversationsEntry],
  );
  // Ready only once THIS workspace's entry has actually appeared in the cache —
  // not merely once a fetch has settled. Two ways "settled" lies: an initial
  // ERROR leaves `sessionsData` undefined with SWR's `isLoading` already false;
  // and a cache warm from BEFORE this workspace was spawned (the key is shared
  // across the drive) answers with real data that has no row for it yet. Both
  // leave `sessionConversations` reading as `[]`, indistinguishable from "no
  // thread exists".
  const sessionKnownToConversationsCache = currentSessionConversationsEntry !== undefined;

  const liveConversationIds = useMemo(
    () => (sessionKnownToConversationsCache ? new Set(sessionConversations.map((c) => c.conversationId)) : undefined),
    [sessionKnownToConversationsCache, sessionConversations],
  );

  // A successful mint writes straight into the tree, but the switch DECISION
  // reads `sessionConversations` from this SWR cache, which only catches up on
  // its next poll. Left alone, switching away from a freshly-minted agent and
  // back inside that window re-runs `selectPaneAgent` against a list that still
  // doesn't know the mint happened — a second mint, a duplicate conversation.
  const recordMintedConversation = useCallback(
    (conversationId: string, agentPageId: string | null) => {
      void mutateSessionConversations((current) => {
        if (!current) return current;
        return {
          sessions: current.sessions.map((session) =>
            session.workspaceId === sessionId
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
  // The mirror, for the opposite direction: a successful close stamps
  // `closedInWorkspaceAt` immediately, but this cache only catches up on its
  // next poll. Left alone, `selectPaneAgent` still sees the just-closed row as
  // open, so picking that agent elsewhere reads as `focus` and silently reopens
  // a conversation the server already considers closed.
  const recordClosedConversation = useCallback(
    (conversationId: string) => {
      void mutateSessionConversations((current) => {
        if (!current) return current;
        return {
          sessions: current.sessions.map((session) =>
            session.workspaceId === sessionId
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
  // until THIS workspace's own entry has appeared.
  const closeDecisionListing: SessionConversationSummary[] | null = sessionKnownToConversationsCache
    ? sessionConversations
    : null;

  /**
   * Selection IS an instruction to show the conversation.
   *
   * NOT a grid seed — there is nothing to seed, because the root is minted
   * server-side by whatever write first needs one. Two outcomes, not the three
   * the parked model needed: the thread is in the tree, so showing it is FOCUS
   * and costs no write at all; or it is nowhere, and it is PLACED. The store
   * owns both (`openConversation`).
   *
   * It still waits for the live conversation set before it can risk an EVICTION.
   * A target already showing never reaches that logic, so that case goes
   * immediately; anything else would let a cold reload reproduce the exact
   * eviction issue #2295 fixes. `sessionKnownToConversationsCache` only flips
   * false→true once (unlike `sessionConversations`, whose array reference
   * changes on every poll), so depending on it adds at most one extra run.
   */
  useEffect(() => {
    if (!initialConversation) return;
    const live = useAgentWorkspaceStore.getState().workspaces[sessionId];
    const alreadyShowing = live ? nodeShowing(live.nodes, 'chat', initialConversation.conversationId) : undefined;
    if (alreadyShowing === undefined && !sessionKnownToConversationsCache) return;

    openConversation(sessionId, initialConversation.conversationId, {
      ...(liveConversationIds === undefined ? {} : { liveConversationIds }),
    });
    // `liveConversationIds` is deliberately excluded: its identity changes on
    // every poll and would re-run this on every tick. Reading it in the closure
    // is exactly as fresh as it needs to be — it is recomputed in the same
    // render that flips `sessionKnownToConversationsCache`, so whenever this
    // effect actually re-runs, the closure already has the matching value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialConversation?.conversationId, openConversation, sessionKnownToConversationsCache]);

  // Ending the workspace: confirmed, and gated on the server. `pendingEnd`
  // carries the node whose close raised it, so the shell it pointed at can be
  // torn down once — and only once — the DELETE has actually succeeded.
  const [pendingEnd, setPendingEnd] = useState<{ nodeId: string } | null>(null);

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

  /**
   * Take the node out of the grid and close its conversation's listing — silent
   * on success, since closing a listing never touches history.
   *
   * The node PARKS rather than vanishing, so the thread's row stays in the
   * sidebar right up until the DELETE confirms it is gone. There is no rebind
   * branch any more: the grid is allowed to be empty.
   */
  const closeConversationListing = useCallback(
    async (nodeId: string, conversationId: string) => {
      // Layout first, and deliberately: parking is reversible and instant, and
      // the alternative — waiting on the DELETE — is what made a close feel like
      // the app had ignored it.
      closePane(sessionId, nodeId);
      try {
        await del(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          // The workspace's LAST open listing — the server is the authority on
          // the never-empty invariant, so fall back to the confirmed
          // end-workspace flow.
          setPendingEnd({ nodeId });
          return;
        }
        console.error('Failed to close this conversation:', error);
        toast.error('Could not close this conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        return;
      }
      onConversationClosed?.({ conversationId, next: null, nextAgentPageId: null });
      recordClosedConversation(conversationId);
      // Instant sidebar freshness — the closed listing's row leaves every open
      // `/api/agent-workspaces**` poll without waiting on its interval.
      void mutate(isAgentWorkspacesKey);
    },
    [sessionId, closePane, onConversationClosed, recordClosedConversation],
  );

  const handleClosePane = useCallback(
    (nodeId: string) => {
      const node = findNode(nodes, nodeId);
      if (node === undefined || node.nodeType !== 'pane') return;
      const decision = decideClosePane({
        panes: paneNodesOf(nodes),
        nodeId,
        activeConversations: closeDecisionListing,
      });

      if (decision.action === 'noop') return;

      // Only once a decision ACTUALLY commits to altering this node: a stale
      // close attempt that changed nothing must not invalidate a genuinely
      // in-flight mint for it.
      beginPaneAssign(nodeId);

      if (decision.action === 'close-pane') {
        closePane(sessionId, nodeId);
        // A closed terminal tab is a DELETE, not an orphan. The node and its
        // binding are gone with the close, so the PTY has no surface left and
        // nothing that could reattach to it — it goes too, rather than being
        // left running for a row that no longer exists.
        if (node.target?.kind === 'terminal') closeShell(node.target.id);
        return;
      }

      void closeConversationListing(nodeId, decision.conversationId);
    },
    [nodes, closePane, sessionId, closeShell, closeDecisionListing, closeConversationListing, beginPaneAssign],
  );

  const confirmEndSession = useCallback(async () => {
    if (!pendingEnd) return;
    // Snapshot the shell (if any) before the tree goes, then assume success: the
    // grid and sidebar row must not wait on the sandbox-kill round trip this
    // DELETE triggers server-side.
    const node = findNode(nodes, pendingEnd.nodeId);
    const shellId = node?.nodeType === 'pane' && node.target?.kind === 'terminal' ? node.target.id : null;
    const sessionEntrySnapshot = sessionsData?.sessions.find((s) => s.workspaceId === sessionId) ?? null;
    forgetWorkspace(sessionId);
    setPendingEnd(null);
    forgetWorkspaceInCache(mutate, sessionId);
    let hadOtherOpenConversations = false;
    try {
      const ended = await del<{ hadOtherOpenConversations?: boolean }>(
        `/api/agent-workspaces/${encodeURIComponent(sessionId)}`,
      );
      hadOtherOpenConversations = ended?.hadOtherOpenConversations ?? false;
    } catch (error) {
      // The optimistic assumption was wrong. Restore the sidebar row LOCALLY (a
      // revalidate rides the same network whose failure is plausibly why the
      // DELETE failed) and go re-read the tree, which is the only honest way
      // back now that the store holds no snapshot of its own to restore.
      if (sessionEntrySnapshot) restoreWorkspaceInCache(mutate, sessionEntrySnapshot);
      void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(sessionId);
      void mutate(isWorkspaceListingKey);
      console.error('Failed to end session:', error);
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      return;
    }
    // Only NOW — server-confirmed — is it safe to tear down the shell. Doing it
    // alongside the optimistic drop would irreversibly kill a live shell before
    // knowing the workspace actually ended.
    if (shellId !== null) closeShell(shellId);
    void mutate(isWorkspaceListingKey);
    if (hadOtherOpenConversations) {
      // Ending is unconditional by design — this can't be prevented client side
      // — but the confirm the user just clicked was shown because a close 409'd
      // on a "last listing" belief that a concurrent mint has since falsified.
      // Silently destroying more than expected deserves a signal.
      toast.warning('This session had other open conversations, which were also ended.');
    }
    onSessionEnded?.();
  }, [pendingEnd, nodes, sessionId, sessionsData, forgetWorkspace, closeShell, onSessionEnded]);

  /** Shared by the orphan cleanup's own post-DELETE recheck and the History pick's rollback. */
  const isConversationShownSomewhere = useCallback(
    (conversationId: string) =>
      nodeShowing(useAgentWorkspaceStore.getState().workspaces[sessionId]?.nodes ?? [], 'chat', conversationId) !==
      undefined,
    [sessionId],
  );

  const cleanupOrphanedConversation = useCallback(
    async (conversationId: string) => {
      // Best-effort: the node that wanted this is already gone, so a failure
      // here leaves a harmless unbound row rather than blocking anything the
      // user can see. Workspace-scoped close (not the history-deleting routes) —
      // this orphan never had any history, and closing its listing also frees
      // the conversation-cap slot it would otherwise hold forever.
      try {
        await del(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
        // This DELETE can be delayed long enough for a LATER, independent pick
        // of this exact conversation to land before it reaches the server —
        // closing a listing that is now visibly displayed. Re-check and
        // compensate rather than leave a pane pointed at a transcript that
        // would 404 on send.
        if (isConversationShownSomewhere(conversationId)) {
          await post(
            `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}/reopen`,
            {},
          );
          // The SAME race applies to the compensating reopen. Recurses rather
          // than loops, so it terminates the moment the tree stops churning
          // through this conversation.
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
   * After a mint or a switch replaces what a node shows, close the conversation
   * it replaced — the fix for panes silently accumulating stray sidebar rows.
   *
   * Nothing is displaced: a binding is for life, so the replacement is PLACED in
   * a node of its own rather than repointing this one. The prior thread keeps
   * its node, stays on screen and stays a member right up until this DELETE
   * lands and destroys it. Runs only AFTER the replacement is in place; a failed
   * mint never touches the prior conversation.
   */
  const closeReplacedConversation = useCallback(
    async (oldConversationId: string, newConversationId: string, newAgentPageId: string | null) => {
      // Never act on an unverified fact: an unresolved listing, or one that has
      // already resolved without this conversation in it, means there is nothing
      // left here to DELETE.
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
      // Only tell the host if the replacement is still what the workspace shows
      // — a later switch, racing ahead of this cleanup's DELETE, already owns
      // whatever is there now.
      if (isConversationShownSomewhere(newConversationId)) {
        onConversationClosed?.({
          conversationId: oldConversationId,
          next: newConversationId,
          nextAgentPageId: newAgentPageId,
        });
      }
      recordClosedConversation(oldConversationId);
      void mutate(isAgentWorkspacesKey);
    },
    [sessionId, closeDecisionListing, isConversationShownSomewhere, onConversationClosed, recordClosedConversation],
  );

  /**
   * Keep the Agents CONSOLE's own selection in sync whenever a node's
   * conversation changes to something the console didn't already know about.
   *
   * Scoped to `chatContext === 'console'`: this component is also embedded in a
   * regular page's chat tab, whose `initialConversation` is driven by its own
   * local state — syncing there would both do nothing useful AND push a
   * `/dashboard/agents` URL, silently navigating a page-embedded chat's user
   * away to the Agents console.
   */
  const syncConsoleSelection = useCallback(
    (conversationId: string, agentPageId: string | null) => {
      if (chatContext !== 'console') return;
      selectConversation({ sessionId, conversationId, agentId: agentPageId });
    },
    [chatContext, selectConversation, sessionId],
  );

  const handlePickAgent = useCallback(
    async (nodeId: string, agentPageId: string | null): Promise<boolean> => {
      // Also supersedes any pending History pick for this node — a slow reopen
      // resolving after the user has since minted a different agent into this
      // same node must not overwrite it.
      const isCurrent = beginPaneAssign(nodeId);
      const conversationId = createId();
      const mint: PendingMint = { kind: 'chat', agentPageId };

      // What this node shows RIGHT NOW, captured before anything moves. The node
      // is not rebound during the mint — that is what the model deleted — so
      // this is a single synchronous read rather than a reference-counted
      // capture, and it stays correct for the whole flight.
      const priorNode = findNode(nodes, nodeId);
      const priorConversationId =
        priorNode?.nodeType === 'pane' && priorNode.target?.kind === 'chat' ? priorNode.target.id : null;

      // Only an UNBOUND node spins: a bound one keeps showing its conversation
      // until the replacement is ready, which is strictly better than blanking a
      // working transcript for the length of a round trip.
      const showsSpinner = priorNode?.nodeType === 'pane' && priorNode.target === null;
      if (showsSpinner) beginMint(nodeId, mint);

      try {
        if (agentPageId === null) {
          // The ASSISTANT: no agent page, so the workspace-centric creator is
          // the path (page-agents has no page to hang this on).
          await post(`/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations`, { conversationId });
        } else {
          await post(`/api/ai/page-agents/${encodeURIComponent(agentPageId)}/conversations`, {
            conversationId,
            sessionId,
          });
        }
        const superseded = !isCurrent() || (showsSpinner && !stillMinting(nodeId, mint));
        if (showsSpinner) endMint(nodeId);
        if (superseded) {
          // A NEWER call for this node superseded this one, or the node was
          // closed or repurposed mid-mint. The row exists server-side either
          // way — clean it up rather than leave an orphaned, unbound thread.
          void cleanupOrphanedConversation(conversationId);
          return false;
        }
        // The placement policy decides where it lands, and `activeNodeId` is how
        // "here, in this pane" is expressed to it. It fills this node when it is
        // unbound and replaces it when it is not — parking whatever it displaced,
        // which stays in the workspace and in the sidebar.
        openConversation(sessionId, conversationId, {
          activeNodeId: nodeId,
          ...(liveConversationIds === undefined ? {} : { liveConversationIds }),
        });
        syncConsoleSelection(conversationId, agentPageId);
        if (priorConversationId !== null) {
          void closeReplacedConversation(priorConversationId, conversationId, agentPageId);
        }
        // Local optimistic update for THIS component's own decisions (instant,
        // no network)...
        recordMintedConversation(conversationId, agentPageId);
        // ...and a broader revalidate covering every OTHER
        // `/api/agent-workspaces**` consumer whose differently-scoped key the
        // local update can't reach.
        void mutate(isAgentWorkspacesKey);
        return true;
      } catch (error) {
        if (showsSpinner) endMint(nodeId);
        console.error('Failed to start a conversation in this pane:', error);
        toast.error('Could not start a conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        // Nothing to restore. The node was never rebound, so a failed mint
        // leaves it exactly as the user left it — which is the whole reason the
        // capture-and-restore machinery this replaced could go.
        return false;
      }
    },
    [
      nodes,
      sessionId,
      beginPaneAssign,
      beginMint,
      endMint,
      stillMinting,
      openConversation,
      liveConversationIds,
      cleanupOrphanedConversation,
      closeReplacedConversation,
      recordMintedConversation,
      syncConsoleSelection,
    ],
  );

  /**
   * A pane's own History tab picking a past conversation — show it HERE, first
   * either reopening it (bound to THIS workspace, closed) or claiming it (never
   * bound to ANY workspace) into this workspace's listing, as needed.
   *
   * A conversation bound to a DIFFERENT workspace is never subject to this one's
   * cap or listing — no server call, straight to placement. Tool calls resolve
   * their sandbox from the CONVERSATION ROW's own persisted workspace, never
   * from which tree happens to display it, so the claim is what makes that
   * lookup resolve here afterwards rather than the chrome being cosmetic.
   *
   * Returns whether the pick actually landed, so the caller can stay on History
   * rather than following a pick that never happened.
   */
  const handlePickHistoryConversation = useCallback(
    async (
      nodeId: string,
      agentPageId: string | null,
      conversation: { id: string; title: string | null; sessionId: string | null; isOwner: boolean },
    ): Promise<boolean> => {
      const isCurrent = beginPaneAssign(nodeId);
      if (conversation.sessionId === sessionId) {
        const isShownSomewhere = () => isConversationShownSomewhere(conversation.id);
        pendingReopenCounts.current.set(conversation.id, (pendingReopenCounts.current.get(conversation.id) ?? 0) + 1);
        // Captured BEFORE the request starts — compared, never consumed, so
        // every concurrent reopen for this id independently notices a delete
        // that happened anywhere during its own flight.
        const deleteGenerationAtStart = historyDeleteGenerations.current.get(conversation.id) ?? 0;
        // Exactly-once decrement regardless of which exit path runs. Returns the
        // count still outstanding AFTER this one settles, so the caller can tell
        // whether it was the LAST one for this conversationId.
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
          // I was the LAST outstanding reopen for this id, and an EARLIER
          // (superseded) request already reopened it server-side but deferred
          // its own cleanup because I was still pending — nothing else will
          // revisit that now I have failed instead of landing it.
          if (remaining <= 0 && deferredReopenSuccess.current.delete(conversation.id) && !isShownSomewhere()) {
            void cleanupOrphanedConversation(conversation.id);
          }
          if (!isCurrent()) return false;
          console.error('Failed to reopen conversation:', error);
          toast.error('Could not reopen this conversation', {
            description: error instanceof Error ? error.message : 'Please try again.',
          });
          return false;
        }
        const remaining = settleReopen();
        if (!isCurrent()) {
          // The reopen SUCCEEDED server-side (a cap slot consumed) after a newer
          // pick superseded this one. Close it back out — but only when it is
          // genuinely orphaned (the same conversation picked twice can have the
          // NEWER request land first), only when THIS request actually
          // transitioned the listing (`alreadyOpen` means it did not), and only
          // when nothing else is still pending for the same id.
          const shownSomewhere = isShownSomewhere();
          const hadDeferredSibling = remaining <= 0 && deferredReopenSuccess.current.delete(conversation.id);
          if (shownSomewhere) return false;
          if (hadDeferredSibling) {
            void cleanupOrphanedConversation(conversation.id);
            return false;
          }
          if (reopenResult.alreadyOpen) return false;
          if (remaining > 0) deferredReopenSuccess.current.add(conversation.id);
          else void cleanupOrphanedConversation(conversation.id);
          return false;
        }
        // I'm the one landing this — any deferred-cleanup marker left by an
        // earlier superseded request for this id is moot now.
        deferredReopenSuccess.current.delete(conversation.id);
        if ((historyDeleteGenerations.current.get(conversation.id) ?? 0) !== deleteGenerationAtStart) {
          // The round trip was still in flight when the SAME conversation was
          // deleted from History, so showing it now would bind a pane to a
          // transcript that already 404s on send.
          return false;
        }
        void mutate(isAgentWorkspacesKey);
      } else if (conversation.sessionId === null && conversation.isOwner) {
        // Genuinely never bound to ANY workspace, AND this caller owns it —
        // claim it into this one so tool calls actually resolve a sandbox
        // afterward. A History list routinely also contains OTHER users' shared,
        // still-unbound conversations; claiming one of those would 404, so the
        // `!isOwner` case falls through to plain placement below, which opens
        // the shared transcript read-only exactly as it always has.
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
          // The BINDING is permanent and can never be rolled back (claiming is
          // not a rebind primitive) — only the open-listing SLOT it consumed
          // can be, under the same non-destructive rule the reopen branch uses.
          const shownSomewhere = isShownSomewhere();
          const hadDeferredSibling = remaining <= 0 && deferredClaimSuccess.current.delete(conversation.id);
          if (shownSomewhere) return false;
          if (hadDeferredSibling) {
            void cleanupOrphanedConversation(conversation.id);
            return false;
          }
          if (claimResult.alreadyInSession) return false;
          if (remaining > 0) deferredClaimSuccess.current.add(conversation.id);
          else void cleanupOrphanedConversation(conversation.id);
          return false;
        }
        deferredClaimSuccess.current.delete(conversation.id);
        if ((historyDeleteGenerations.current.get(conversation.id) ?? 0) !== deleteGenerationAtStart) return false;
        // Only when THIS request actually transitioned the listing —
        // `recordMintedConversation` has no id-based dedupe, so calling it for
        // an `alreadyInSession` no-op would prepend a duplicate row.
        if (!claimResult.alreadyInSession) recordMintedConversation(conversation.id, agentPageId);
        void mutate(isAgentWorkspacesKey);
      }

      if (!isCurrent()) return false;
      // ONE placement call for every branch. The store owns the two cases the
      // duplicated block here used to hand-roll — already in the tree (focus
      // it), nowhere (place it) — and it reads live
      // state, which is what two panes racing to reopen the same conversation
      // need: a stale pre-request snapshot would let both miss the other's
      // arrival and independently place it, which the chat-target index refuses.
      const priorNode = findNode(useAgentWorkspaceStore.getState().workspaces[sessionId]?.nodes ?? [], nodeId);
      const priorConversationId =
        priorNode?.nodeType === 'pane' && priorNode.target?.kind === 'chat' ? priorNode.target.id : null;
      openConversation(sessionId, conversation.id, {
        activeNodeId: nodeId,
        ...(liveConversationIds === undefined ? {} : { liveConversationIds }),
      });
      if (priorConversationId !== null && priorConversationId !== conversation.id) {
        void closeReplacedConversation(priorConversationId, conversation.id, agentPageId);
      }
      return true;
    },
    [
      sessionId,
      openConversation,
      liveConversationIds,
      beginPaneAssign,
      cleanupOrphanedConversation,
      closeReplacedConversation,
      isConversationShownSomewhere,
      recordMintedConversation,
    ],
  );

  /**
   * A pane's History tab deleting a conversation — every node in THIS tree still
   * showing that id is left with a dead transcript: staying on it would render
   * nothing sendable with no obvious way out.
   *
   * A binding is for life, so each affected node is DESTROYED and a fresh unbound
   * one takes its slot (`unbindPane`). The pane the user was looking at is still
   * a pane in the same place, showing the picker — the simplest safe recovery,
   * with the user explicitly picking what is next rather than a guessed
   * replacement.
   */
  const handleHistoryDeleteConversation = useCallback(
    (deletedConversationId: string) => {
      // Bumped unconditionally, not just when a node is currently affected: a
      // reopen for this exact id can be mid-flight right now, from more than one
      // node at once, having already committed server-side.
      historyDeleteGenerations.current.set(
        deletedConversationId,
        (historyDeleteGenerations.current.get(deletedConversationId) ?? 0) + 1,
      );
      // Instant-freshness nudge, unconditional — the canonical row is gone from
      // the listing regardless of whether any node here is showing it.
      void mutate(isAgentWorkspacesKey);
      // Read fresh at call time: this always runs after the DELETE's own round
      // trip, during which the user could have already repurposed a node.
      const live = useAgentWorkspaceStore.getState().workspaces[sessionId];
      if (!live) return;
      for (const node of paneNodesOf(live.nodes)) {
        if (node.target?.kind === 'chat' && node.target.id === deletedConversationId) {
          unbindPane(sessionId, node.id);
        }
      }
    },
    [sessionId, unbindPane],
  );

  /**
   * The pane bar selector's switch — a two-way decision: the picked agent already
   * has an open conversation somewhere in the workspace (show THAT here), or it
   * does not (mint). Either way, replacing this node's content closes the
   * OUTGOING conversation's listing — the fix for panes silently accumulating
   * stray sidebar rows.
   */
  const handleSwitchAgent = useCallback(
    (nodeId: string, currentAgentPageId: string | null, nextAgentPageId: string | null) => {
      const decision = selectPaneAgent({
        sessionConversations,
        selectedAgentPageId: nextAgentPageId,
        currentAgentPageId,
      });
      if (decision.action === 'noop') return;
      if (decision.action === 'focus-existing') {
        const node = findNode(nodes, nodeId);
        const oldTargetId = node?.nodeType === 'pane' && node.target?.kind === 'chat' ? node.target.id : null;
        openConversation(sessionId, decision.conversationId, {
          activeNodeId: nodeId,
          ...(liveConversationIds === undefined ? {} : { liveConversationIds }),
        });
        syncConsoleSelection(decision.conversationId, nextAgentPageId);
        if (oldTargetId !== null && oldTargetId !== decision.conversationId) {
          void closeReplacedConversation(oldTargetId, decision.conversationId, nextAgentPageId);
        }
        return;
      }
      void handlePickAgent(nodeId, nextAgentPageId);
    },
    [
      nodes,
      sessionConversations,
      sessionId,
      openConversation,
      liveConversationIds,
      closeReplacedConversation,
      handlePickAgent,
      syncConsoleSelection,
    ],
  );

  const handlePickShell = useCallback(
    async (nodeId: string) => {
      const mint: PendingMint = { kind: 'terminal', agentPageId: null };
      beginMint(nodeId, mint);
      try {
        const { shell } = await post<{ shell: { shellId: string; name: string } }>(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells`,
          {},
        );
        const superseded = !stillMinting(nodeId, mint);
        endMint(nodeId);
        if (superseded) {
          // The shell exists server-side already, so close it rather than leave
          // it running unattached or clobber whatever this node became.
          closeShell(shell.shellId);
          return;
        }
        bindPane(sessionId, nodeId, { kind: 'terminal', id: shell.shellId });
      } catch (error) {
        endMint(nodeId);
        console.error('Failed to open a shell in this pane:', error);
        toast.error('Could not open a shell', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      }
    },
    [beginMint, endMint, stillMinting, bindPane, sessionId, closeShell],
  );

  const handleReattachShell = useCallback(
    (nodeId: string, shellId: string) => bindPane(sessionId, nodeId, { kind: 'terminal', id: shellId }),
    [bindPane, sessionId],
  );

  // A page binding addresses an existing page directly — unlike a conversation
  // or a shell there is nothing to mint, so this is a single synchronous bind.
  const handlePickPage = useCallback(
    (nodeId: string, pageId: string) => bindPane(sessionId, nodeId, { kind: 'page', id: pageId }),
    [bindPane, sessionId],
  );

  const paneLabel = useCallback((node: PaneNode) => titleOf(targetIndex, node), [targetIndex]);

  const renderPane = ({
    node,
    isActive,
    canSplit,
  }: {
    node: PaneNode;
    isActive: boolean;
    canSplit: boolean;
  }) => {
    const surface = resolvePaneSurface(node, node.id in pendingMints);

    // A chat pane owns real Chat/History/Settings tabs and the state that
    // switches between them — its own component, because hooks cannot run inside
    // a render-prop map across a pane count that changes on every split.
    if (surface.surface === 'chat') {
      const resolved = lookupTarget(targetIndex, node);
      return (
        <ChatPane
          conversationId={surface.conversationId}
          // The agent a chat pane belongs to, resolved beside the tree and behind
          // the same gate its title passed. A target this viewer may not read
          // has no entry at all, so this reads as the Assistant — which is what
          // an unnameable thread renders as everywhere else.
          agentPageId={resolved?.agentPageId ?? null}
          title={titleOf(targetIndex, node)}
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
          onSelectAgent={(nextAgentPageId) =>
            handleSwitchAgent(node.id, resolved?.agentPageId ?? null, nextAgentPageId)
          }
          onSelectPane={() => selectNode(sessionId, node.id)}
          onSplitRight={() => splitPane(sessionId, node.id, 'row')}
          onSplitDown={() => splitPane(sessionId, node.id, 'column')}
          onClose={() => handleClosePane(node.id)}
          // The "+" chip and History's own "New Conversation" button are the
          // identical call — both start a fresh conversation with this pane's
          // current agent, replacing what is showing.
          onCreateNewFromHistory={() => handlePickAgent(node.id, resolved?.agentPageId ?? null)}
          onPickHistoryConversation={(conversation) =>
            handlePickHistoryConversation(node.id, resolved?.agentPageId ?? null, conversation)
          }
          onHistoryDeleteConversation={handleHistoryDeleteConversation}
        />
      );
    }

    return (
      <div
        className="group/pane flex h-full min-h-0 flex-col"
        onClick={() => selectNode(sessionId, node.id)}
        // Tabbing into any control inside a pane (the chat input, a close
        // button) must activate it too — a click is not the only way in.
        onFocusCapture={() => selectNode(sessionId, node.id)}
      >
        <PaneBar
          isActive={isActive}
          identity={
            node.target ? (
              <PaneSessionIdentity name={titleOf(targetIndex, node)} />
            ) : (
              <span className="text-muted-foreground">New pane</span>
            )
          }
          actions={
            <PaneSplitCloseActions
              canSplit={canSplit}
              canClose
              onSplitRight={() => splitPane(sessionId, node.id, 'row')}
              onSplitDown={() => splitPane(sessionId, node.id, 'column')}
              onClose={() => handleClosePane(node.id)}
            />
          }
        />
        <div className="min-h-0 flex-1">
          {surface.surface === 'picker' ? (
            <PanePicker
              agents={pickableAgents}
              driveId={driveId}
              isLoading={agentsLoading}
              canRunSandbox={canRunSandbox}
              existingShells={reattachableShells}
              // Every workspace offers the global assistant, symmetric with a
              // global workspace offering every accessible agent.
              canPickAssistant
              autoFocus={tree?.pendingPickerNodeId === node.id}
              onPickAgent={(agentPageId) => void handlePickAgent(node.id, agentPageId)}
              onPickShell={() => void handlePickShell(node.id)}
              onReattachShell={(shellId) => handleReattachShell(node.id, shellId)}
              onPickPage={(pageId) => handlePickPage(node.id, pageId)}
            />
          ) : surface.surface === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : surface.surface === 'page' ? (
            <PagePaneView pageId={surface.pageId} />
          ) : surface.surface === 'terminal' ? (
            <Shell key={surface.shellId} shellId={surface.shellId} name={titleOf(targetIndex, node)} />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <SessionPanes
        nodes={nodes}
        activeNodeId={tree?.activeNodeId ?? null}
        onSelectPane={(nodeId) => selectNode(sessionId, nodeId)}
        renderPane={renderPane}
        paneLabel={paneLabel}
      />
      <EndSessionDialog
        open={pendingEnd !== null}
        onOpenChange={(open) => {
          if (!open) setPendingEnd(null);
        }}
        onConfirm={() => void confirmEndSession()}
      />
    </>
  );
}

type PaneChatTab = 'chat' | 'history' | 'settings';

/**
 * A chat pane, in full: the bar identity (AISelector + Chat/History/Settings tab
 * strip) AND the body those tabs switch between. One component, not two, because
 * the tabs live in the bar but the state they drive has to reach the body below
 * it — `renderPane` itself cannot hold that state (a plain function invoked per
 * pane, not a component; hooks would violate their own rules across a pane count
 * that changes on every split), so this is the pane-bar-plus-body wrapper pulled
 * out for this one kind's own hooks.
 *
 * History and Settings reuse the SAME hooks (`useConversations`,
 * `useAgentConfig`) the page's own `AgentPageView` tabs use — the whole point
 * being that a pane and the page view are not two parallel implementations of
 * "this agent's history/settings": they are the same SWR-keyed data, so two
 * panes on the same agent can never silently drift.
 */
function ChatPane({
  conversationId,
  agentPageId,
  title,
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
  conversationId: string;
  /** Resolved from `targets[]` — `null` for the Assistant and for a thread this viewer cannot name. */
  agentPageId: string | null;
  title: string;
  isActive: boolean;
  canSplit: boolean;
  pickableAgents: PickableAgent[];
  agentsLoading: boolean;
  /**
   * Whether THIS workspace's entry has appeared in the switch decision's own
   * data. Before it has, that list reads as `[]` — indistinguishable from "no
   * conversation with this agent exists yet" — and a switch to an agent that
   * already HAS a thread would wrongly mint a duplicate. Disabled, not raced.
   */
  conversationsReady: boolean;
  driveId: string | null;
  sessionId: string;
  chatContext?: 'page' | 'console';
  hostConversationId?: string | null;
  isReadOnly: boolean;
  onSelectAgent: (agentPageId: string | null) => void;
  onSelectPane: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
  /** Starts a new conversation with this pane's current agent, replacing what it shows. */
  onCreateNewFromHistory: () => Promise<boolean>;
  /** Resolves to whether the pick actually landed — false on a failed reopen. */
  onPickHistoryConversation: (conversation: {
    id: string;
    title: string | null;
    sessionId: string | null;
    isOwner: boolean;
  }) => Promise<boolean>;
  /** A History delete reaches every pane showing that id, not just this one — the container handles each. */
  onHistoryDeleteConversation: (conversationId: string) => void;
}) {
  const { user } = useAuth();
  const { agent } = useResolvedAgent(agentPageId);
  // The channel a stream for this conversation would be tagged with — an agent's
  // own page id, or the user's global channel for the Assistant.
  const streamPageId = agentPageId ?? (user?.id ? globalChannelId(user.id) : null);
  const activeStream = useConversationActiveStream(streamPageId, conversationId);
  // Mid-stream, or the switch decision's own data doesn't know this workspace
  // yet: neither has anything safe to switch against.
  const disabledAgentSwitch = activeStream !== undefined || !conversationsReady;
  // Blocking a live stream is required either way — replacing the pane would
  // yank a still-arriving response (and any in-flight tool work) out from under
  // itself, with no way back.
  const blockedByActiveStream = activeStream !== undefined;
  const disabledNewConversation = blockedByActiveStream || !conversationsReady;

  const [activeTab, setActiveTab] = useState<PaneChatTab>('chat');

  // A pane's agent can change under it without remounting this component.
  // Settings belongs to the OLD agent — showing it after switching presents that
  // agent's config as if requested, and switching to the Assistant (no Settings
  // tab at all) leaves the body on a spinner that can never resolve. This pane's
  // identity collapsing to `hostConversationId` removes the tab strip entirely,
  // which strands it the same way.
  const isHostIdentity = conversationId === hostConversationId;
  useEffect(() => {
    setActiveTab('chat');
  }, [agentPageId, isHostIdentity]);

  const {
    conversations,
    isLoading: conversationsLoading,
    deleteConversation,
    refreshConversations,
  } = useConversations({
    agentId: agentPageId,
    currentConversationId: conversationId,
    // Only fetched while History is actually showing — the same lazy-load
    // discipline `AgentPageView`'s own History tab uses.
    enabled: activeTab === 'history',
  });

  const { config: agentConfig, setConfig: setAgentConfig, revalidate: revalidateAgentConfig } = useAgentConfig(agentPageId);
  const {
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings(agentPageId ? { pageId: agentPageId } : {});
  // clean/dirty/saving/saved — the same state machine as AgentPageView's Save
  // Settings button, scaled down for this 30px pane bar. `agentConfig === null`
  // folds into "clean": the settings tab registers `submitForm` before its own
  // config-loaded check returns, and its form defaults contain an EMPTY
  // prompt/tool list, so this button must stay inert until real config has
  // loaded and been edited.
  const {
    saveState: settingsSaveState,
    setIsSaving: setIsSettingsSaving,
    setIsDirty: setIsSettingsDirty,
    handleSaved: handleSettingsSaved,
  } = useAgentSettingsSaveState({ isConfigLoaded: agentConfig !== null });
  const settingsRef = useRef<PageAgentSettingsTabRef>(null);

  const toggleConversationShare = useCallback(
    async (targetConversationId: string, isShared: boolean) => {
      if (agentPageId === null) return;
      try {
        const response = await fetchWithAuth(
          `/api/ai/page-agents/${agentPageId}/conversations/${targetConversationId}`,
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
    [agentPageId],
  );

  const handleSelectHistoryConversation = useCallback(
    async (id: string) => {
      const picked = conversations.find((c) => c.id === id);
      // Only follow the pick to Chat once it actually landed — a failed reopen
      // leaves the pane untouched, and switching tabs anyway would show the OLD
      // content as if the pick had succeeded.
      const landed = await onPickHistoryConversation({
        id,
        title: picked?.title ?? null,
        sessionId: picked?.sessionId ?? null,
        isOwner: picked?.isOwner ?? false,
      });
      if (landed) {
        setActiveTab('chat');
        // A successful pick of a never-bound conversation just claimed it into
        // this workspace — this pane's own History list still holds the stale
        // `sessionId: null` for that row until refreshed.
        refreshConversations();
      }
    },
    [conversations, onPickHistoryConversation, refreshConversations],
  );

  const handleCreateNewFromHistory = useCallback(async () => {
    // Blocks only on an active stream — History's "New Conversation" button
    // reaches this same action with no button-level guard of its own, so it is
    // checked here once instead of threading a prop through the shared tab.
    if (blockedByActiveStream) return;
    const landed = await onCreateNewFromHistory();
    if (landed) setActiveTab('chat');
  }, [blockedByActiveStream, onCreateNewFromHistory]);

  return (
    <div
      className="group/pane flex h-full min-h-0 flex-col"
      onClick={onSelectPane}
      onFocusCapture={onSelectPane}
    >
      <PaneBar
        isActive={isActive}
        identity={
          isHostIdentity ? (
            // This pane shows the SAME conversation the hosting AI_CHAT page's
            // own header already identifies — a second selector and tab strip
            // would be duplicate chrome for the identical thing. Matched by
            // CONVERSATION, not agent: a split pane pointed at the same agent but
            // a DIFFERENT conversation keeps its full selector, since that is its
            // only in-grid way to be managed.
            <PaneSessionIdentity name={agent?.title ?? title} />
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-0.5">
              <AISelector
                selectedAgent={agentPageId === null ? null : agent}
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
                // The Assistant (agentPageId null) has no page, so no Settings.
                showSettings={agentPageId !== null}
                agentTitle={agent?.title ?? 'Agent'}
              />
            </div>
          )
        }
        actions={
          <>
            {activeTab === 'settings' && agentPageId !== null && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  settingsRef.current?.submitForm();
                }}
                // Only clickable once there is something to save — also the guard
                // against clicking before agentConfig arrives.
                disabled={settingsSaveState !== 'dirty'}
                // The state change (Saving.../Saved) is the ONLY save
                // confirmation — there is no toast — so screen readers need this.
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
          <PaneChat
            sessionId={sessionId}
            conversationId={conversationId}
            agentPageId={agentPageId}
            driveId={driveId}
            context={chatContext}
            isReadOnly={isReadOnly}
          />
        ) : activeTab === 'history' ? (
          <PageAgentHistoryTab
            conversations={conversations}
            currentConversationId={conversationId}
            onSelectConversation={handleSelectHistoryConversation}
            onCreateNew={handleCreateNewFromHistory}
            onDeleteConversation={(id) => {
              // Only act on panes once the delete actually succeeded — a refused
              // delete (the never-empty guard's 409) or a network failure both
              // leave the conversation exactly as it was server-side, and
              // unbinding live panes anyway would discard a working binding for
              // nothing.
              void deleteConversation(id).then((succeeded) => {
                if (succeeded) onHistoryDeleteConversation(id);
              });
            }}
            onToggleShare={toggleConversationShare}
            isLoading={conversationsLoading}
          />
        ) : agentPageId !== null && agent ? (
          <div className="h-full overflow-auto">
            <PageAgentSettingsTab
              ref={settingsRef}
              pageId={agentPageId}
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
 * `AgentPageView`'s spacious text pills), tooltipped/aria-labeled for the text a
 * mouse-hover or screen reader still needs.
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

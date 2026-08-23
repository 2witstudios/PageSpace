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
import useSWR, { useSWRConfig } from 'swr';
import type { Cache } from 'swr';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { ApiRequestError, fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useWorkspaceLayoutSync } from '@/stores/agent-workspace/useWorkspaceLayoutSync';
import {
  conversationDirectoryOf,
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
  isAgentWorkspacesKey,
  isWorkspaceListingKey,
  forgetWorkspaceInCache,
  restoreWorkspaceInCache,
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
   * Fired after a conversation's LISTING closed. TWO callers, and `next` is what
   * tells them apart:
   *
   *  - A direct close sends `next: null`. Closing never rebinds a pane to a
   *    replacement, because the grid is allowed to be empty — so there is
   *    nothing to hand the host but the fact.
   *  - The cleanup after a mint or a switch sends the REPLACEMENT's id, because
   *    there the thread that closed was displaced by one the user is now looking
   *    at. `AgentPageView` branches on exactly that: a non-null `next` whose
   *    `nextAgentPageId` is its own page navigates to it instead of minting.
   *
   * The shape is kept so a host tracking "current conversation" independently of
   * the tree can decide for itself what a closed conversation means for whatever
   * it is showing elsewhere.
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
 * Mark the directory probe answered, but only if it is still the SAME one — a
 * member set that changed while the read was in flight started its own probe,
 * and stamping this answer onto it would arm readiness against a question
 * nobody asked.
 */
function markAnswered(
  current: { signature: string; answered: boolean } | null,
  signature: string,
): { signature: string; answered: boolean } | null {
  return current !== null && current.signature === signature ? { signature, answered: true } : current;
}

/**
 * Is this cache entry the session LISTING's body?
 *
 * This grid no longer subscribes to that listing — it reads its conversations
 * from the tree (see `conversationDirectory` below) — but the end-session
 * rollback still needs the SIDEBAR's row for this workspace, and the sidebar
 * owns that cache. Read through SWR's cache rather than a hook so a body of an
 * unexpected shape is refused instead of asserted.
 */
function isSessionListingBody(value: unknown): value is { sessions: SessionListEntry[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  );
}

/**
 * This workspace's sidebar row, from ANY open session listing.
 *
 * Scoped by the same predicate the cache WRITERS use rather than by one built
 * key, because a rollback snapshot narrower than the removal it has to undo is
 * how a live workspace disappears from the sidebar: see `confirmEndSession`.
 * First match wins — the row is the same workspace whichever scope fetched it,
 * and the rollback only needs one copy to put back.
 */
function findSessionInListingCache(cache: Cache, sessionId: string): SessionListEntry | null {
  for (const key of cache.keys()) {
    if (!isWorkspaceListingKey(key)) continue;
    const body = cache.get(key)?.data;
    if (!isSessionListingBody(body)) continue;
    const row = body.sessions.find((session) => session.workspaceId === sessionId);
    if (row !== undefined) return row;
  }
  return null;
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
  // NON-REACTIVE by design — see `isSessionListingBody`. Used once, inside the
  // end-session rollback.
  // BOTH from the same config, deliberately. `mutate` used to be the bare
  // top-level import, which targets SWR's DEFAULT cache regardless of the
  // provider this tree is actually mounted under — so the rollback below could
  // read its snapshot from one cache and write its removal to another.
  // `forgetWorkspaceInCache`'s own doc asks callers for the mutate bound to
  // their cache for exactly this reason; this is that.
  const { cache, mutate } = useSWRConfig();

  const nodes = useMemo(() => tree?.nodes ?? [], [tree]);
  const targetIndex = useMemo(() => indexTargets(tree?.targets ?? []), [tree]);

  // Whether THIS workspace's payer (not the viewing user) is sandbox-eligible —
  // server-resolved (the client only knows its own tier, the wrong axis for a
  // shared drive). Defaults to true while unresolved: a workspace that has
  // ALREADY provisioned a Sprite is proof enough that it was eligible, and the
  // picker's Shell/reattach buttons mustn't flash disabled on every mount.
  const { data: sessionRecordData } = useSessionRecord(sessionId);
  const canRunSandbox = sessionRecordData?.sandboxEligible ?? true;
  // Defaults to FALSE, unlike `canRunSandbox` above — and the asymmetry is
  // deliberate. An optimistic sandbox flag costs a button that flashes
  // enabled; an optimistic END flag costs a confirm dialog raised for someone
  // the server will refuse, and the user has already agreed to destroy their
  // session by the time they learn that. Until the record resolves, closing
  // the last pane just closes it.
  const canEndSession = sessionRecordData?.canEndSession ?? false;

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
   * Is `nodeId` STILL this mint's to land in — a node ON THE GRID that nothing
   * else has claimed?
   *
   * The grid clause is what stops a result landing in a rectangle the user
   * closed mid-mint.
   *
   * **`mintedTargetId` is the answer to a trap the node model set.** This asked
   * only whether the pane was still UNBOUND, which was the whole question while
   * the client was the only thing that could bind one. It is not any more: a
   * mint's own server write ADMITS what it created, and admitting places —
   * `admit` → `place` fills exactly this pane, because "only an unbound pane may
   * be filled ... is what makes the picker path land in the very pane the user
   * is looking at" (`workspace-membership.ts`). The `session:<id>` broadcast then
   * binds it here before this check ever runs.
   *
   * So the SUCCESS case — the server placed what we asked for, in the pane we
   * asked for — became indistinguishable from the abandonment case, and both
   * callers answer abandonment by destroying what they just made: the chat mint
   * deletes its conversation, the shell mint kills its shell. That is the pane
   * appearing and then vanishing with nothing said, since both cleanups are
   * deliberately silent.
   *
   * A pane bound to THIS MINT'S OWN target is therefore still this mint's pane.
   * Bound to anything else, it was genuinely taken, and the caller should still
   * clean up. Callers that cannot name their target (there are none today) may
   * omit it and get the old unbound-only rule.
   */
  const stillMinting = useCallback(
    (nodeId: string, mint: PendingMint, mintedTargetId?: string) => {
      const outstanding = pendingMintsRef.current[nodeId];
      if (!outstanding || outstanding.kind !== mint.kind || outstanding.agentPageId !== mint.agentPageId) return false;
      const node = findNode(useAgentWorkspaceStore.getState().workspaces[sessionId]?.nodes ?? [], nodeId);
      if (node === undefined || node.nodeType !== 'pane' || node.parentId === null) return false;
      // Still waiting: nothing has bound it, so this mint may fill it.
      if (node.target === null) return true;
      // Already carrying what this mint produced — the server got there first,
      // which is the write landing, not a race being lost.
      return mintedTargetId !== undefined && node.target.id === mintedTargetId;
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
  // OBSERVE the same token without taking it — for a handler that has to survive
  // an await before it knows whether it will act at all. Claiming to find out is
  // not free: the token is what an in-flight mint reads to decide it was
  // superseded, and a claim it then never uses would have that mint DELETE the
  // conversation it just created. Peek across the await; the claim belongs to
  // whoever actually rebinds the pane.
  const peekPaneAssign = useCallback((nodeId: string) => paneAssignTokens.current.get(nodeId), []);

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

  /**
   * THIS WORKSPACE'S CONVERSATIONS, from the tree this grid already holds.
   *
   * It used to be a second read of `GET /api/agent-workspaces`, and that read
   * was wrong for a workspace owned by ANOTHER drive member: every filter on
   * that listing carries `ownerId`, while the grid reached this workspace
   * through `checkSessionAccess` — drive MEMBERSHIP. A member's own thread
   * inside a colleague's workspace (which `decideAgentSessionAccess` allows on
   * purpose — that is what makes workspaces shared working contexts) therefore
   * rendered its chat and then disabled every control around it, because the
   * listing never returned the row and readiness never armed. The history list
   * is that thread's only route back, so the broken path was the only path.
   *
   * The tree answers the same question through the gate this grid actually
   * passed: `useWorkspaceLayoutSync` above reads it from the membership-gated
   * nodes route and keeps it live on `session:<id>`, the per-workspace room
   * every member joins. One source, and it is the one that can see this
   * workspace.
   */
  const conversationDirectory = useMemo(() => conversationDirectoryOf(tree), [tree]);

  /**
   * The one re-read this grid makes for a member whose facts never arrived, and
   * whether it has come back. See the effect below for why a failure counts.
   */
  const [directoryProbe, setDirectoryProbe] = useState<{ signature: string; answered: boolean } | null>(null);

  /**
   * The member set, as one comparable value — what the probe below is keyed on
   * and what readiness checks its answer against.
   */
  const directorySignature = useMemo(
    () => (conversationDirectory === null ? null : [...conversationDirectory.memberConversationIds].sort().join(',')),
    [conversationDirectory],
  );

  /**
   * Safe to make an agent-keyed decision against. TWO facts, and the second is
   * not redundant: a structural broadcast adds a member to `nodes` while its
   * per-viewer facts stay behind (see `conversationDirectoryOf`), so a tree can
   * be server-read and still hold a conversation whose agent nobody here knows.
   * Deciding then would read "no thread for this agent" and mint a duplicate.
   *
   * **Unresolved is not forever, and that is the third clause.** A missing target
   * entry means "gone, or not readable by this viewer" just as often as it means
   * "not fetched yet" — the two are deliberately indistinguishable
   * (`readWorkspaceNodes` omits both). A member in the first state never gets an
   * entry, however many times we ask, so blocking on `hasUnresolved` alone left
   * the switcher and New Conversation dead for the rest of the session on a
   * thread that was merely deleted. Once the probe below has ASKED and been
   * answered, whatever is still missing is missing for good: readiness arms and
   * the switch decides against the members it can actually name. Worst case is a
   * thread nobody here can identify failing to match, which mints one extra
   * conversation — strictly better than controls that never come back.
   */
  const conversationsReady =
    conversationDirectory !== null &&
    (!conversationDirectory.hasUnresolved ||
      (directoryProbe !== null && directoryProbe.signature === directorySignature && directoryProbe.answered));

  const liveConversationIds = conversationDirectory?.memberConversationIds;

  /**
   * The membership set, as `decideClosePane` wants it — and `null` while the
   * directory has not resolved, because a close must never act on an unverified
   * fact. Membership (not the resolved subset) is the right input: closing a
   * node is about whether this workspace holds the thread, which is a question
   * the nodes answer on their own.
   */
  const closeDecisionListing = useMemo(
    () =>
      conversationDirectory === null
        ? null
        : [...conversationDirectory.memberConversationIds].map((conversationId) => ({ conversationId })),
    [conversationDirectory],
  );

  /**
   * ONE authorized re-read when a member arrives with no facts — and the record
   * that it was answered.
   *
   * The `session:<id>` broadcast is structural — it cannot carry per-viewer
   * titles or agents — so a thread another member just placed lands in `nodes`
   * alone and leaves the agent-keyed decisions unsafe until someone asks.
   * Nothing else would ask: the mount-time read already happened, and the
   * directory events that would otherwise say so ride the OWNER's
   * `user:<id>:sessions` room, which a non-owner never joins.
   *
   * `answered` is what readiness above waits on, and it is set for a FAILED read
   * too. That is deliberate rather than sloppy: the failure modes it has to
   * survive are a request that never succeeds (offline, a 5xx) and a target that
   * can never resolve (deleted, or not this viewer's to read), and treating
   * either as "still pending" is what left the controls dead for the rest of the
   * session. Recovery does not depend on this effect retrying — the socket's own
   * reconnect re-reads the snapshot, and any change to the member set starts a
   * fresh probe because the signature changes with it.
   *
   * BUT A FAILED READ ANSWERS NOTHING, so it is worth exactly one more ask.
   * `refreshWorkspaceSnapshot` reports failure as `false` rather than throwing,
   * and that boolean is the one thing here that can tell "we asked and the facts
   * are not ours to have" from "we never got to ask". Arming on the first
   * failure conflates them: one dropped request at the moment another member's
   * thread lands leaves readiness armed against a list missing that thread, and
   * the switch then reads "no thread for this agent" and mints a DUPLICATE.
   * Bounded at one retry, and armed either way afterwards — the point is to stop
   * conflating the two states, not to keep asking until the network agrees.
   *
   * Deduplicated by the member set rather than a bare boolean: repeated
   * broadcasts, and a local mint's own echo, must not each fire a read. The
   * store's `snapshot.rev < sync.rev` guard handles an older response landing
   * late.
   */
  useEffect(() => {
    if (conversationDirectory === null || !conversationDirectory.hasUnresolved || directorySignature === null) return;
    if (directoryProbe !== null && directoryProbe.signature === directorySignature) return;
    setDirectoryProbe({ signature: directorySignature, answered: false });
    const ask = async () => {
      const read = () => useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(sessionId);
      if (await read()) return;
      await read();
    };
    void ask().then(
      () => setDirectoryProbe((current) => markAnswered(current, directorySignature)),
      () => setDirectoryProbe((current) => markAnswered(current, directorySignature)),
    );
  }, [conversationDirectory, directoryProbe, directorySignature, sessionId]);

  /**
   * Selection IS an instruction to show the conversation.
   *
   * NOT a grid seed — there is nothing to seed, because the root is minted
   * server-side by whatever write first needs one. Two outcomes, not the three
   * the parked model needed: the thread is in the tree, so showing it is FOCUS
   * and costs no write at all; or it is nowhere, and it is PLACED. The store
   * owns both (`openConversation`).
   *
   * It still waits for the membership set before it can risk an EVICTION. A
   * target already showing never reaches that logic, so that case goes
   * immediately; anything else would let a cold reload reproduce the exact
   * eviction issue #2295 fixes. The gate is DIRECTORY RESOLUTION, not full
   * readiness: placing a conversation needs to know which panes may be
   * displaced, and that is membership — the unresolved-facts question belongs
   * to the agent-keyed decisions, and waiting on it here would strand the
   * initial open behind a re-read it does not need.
   */
  const directoryResolved = conversationDirectory !== null;
  useEffect(() => {
    if (!initialConversation) return;
    const live = useAgentWorkspaceStore.getState().workspaces[sessionId];
    const alreadyShowing = live ? nodeShowing(live.nodes, 'chat', initialConversation.conversationId) : undefined;
    if (alreadyShowing === undefined && !directoryResolved) return;

    openConversation(sessionId, initialConversation.conversationId, {
      ...(liveConversationIds === undefined ? {} : { liveConversationIds }),
    });
    // `liveConversationIds` is deliberately excluded: its identity changes with
    // every tree commit and would re-run this on each one. Reading it in the
    // closure is exactly as fresh as it needs to be — it is recomputed in the
    // same render that flips `directoryResolved`, so whenever this effect
    // actually re-runs, the closure already has the matching value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialConversation?.conversationId, openConversation, directoryResolved]);

  // Ending the workspace: confirmed, and gated on the server. `pendingEnd`
  // carries the node whose close raised it, so the shell it pointed at can be
  // torn down once — and only once — the DELETE has actually succeeded.
  const [pendingEnd, setPendingEnd] = useState<{ nodeId: string } | null>(null);

  /**
   * Close a shell: kill the PTY, drop the row, and — since #2462 — take its
   * pane with it. The route kills the process first and then writes the row and
   * the node together (see `killShellById` for why those are the two halves).
   *
   * **404 IS SUCCESS, because the route says so.** Its own doc states the
   * contract verbatim: "A shell that does not exist (or lives under a different
   * session than the URL claims) is a 404, which the client treats as success —
   * killing something already gone IS success (`planKillTarget`)." This did not
   * honour it: every non-2xx toasted, so closing the tab of a shell whose row
   * had already gone — with an ended session, or a close the user clicked twice
   * — reported "Could not close the shell / Shell not found" for a close that
   * had in fact happened (#2473).
   *
   * That is the same shape as the phantom conversation toast documented on
   * {@link closeChatPane} below, and it is settled the same way: the LOSER of a
   * race that reached the state it wanted is not an error. What it is NOT
   * settled by is making the route answer 200 for a shell it never found —
   * "already gone" and "killed it" are different facts, and the DELETE is the
   * only place that can still tell them apart.
   *
   * **The 404 is WIDER than "already gone", and that is accepted rather than
   * unnoticed.** `workspaceNotFoundOrDenied` answers the same 404 for a caller
   * whose access was revoked while the session was open (its own doc: not-found
   * and every denial land on the SAME status, so a prober cannot tell them
   * apart). A client cannot separate them either — that is the point of the
   * family policy — so this swallows a revoked user's failed close too. It
   * still LOGS, because "nothing happened at all" is the one thing a support
   * conversation cannot work with.
   *
   * That user is not left in silence, though, and the reason is the OTHER
   * writer: the same close queues a node drop, `/nodes` answers it with the
   * same denial, and a non-409 4xx there abandons the queue and raises
   * `queueErrors: 'refused'` — "That can't be shown in this workspace. The
   * layout has been put back to what the server has." Which is the accurate
   * account of what happened, from the write that owns the pane.
   *
   * Everything else still toasts. A 502 means the kill genuinely failed and the
   * process may still be running — see {@link handleClosePane} for what that
   * leaves on screen, and why the message says where to find it.
   */
  const closeShell = useCallback(
    (shellId: string) => {
      void del(`/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}`).catch(
        (error) => {
          if (error instanceof ApiRequestError && error.status === 404) {
            console.debug('Close shell: nothing to close (already gone, or no longer permitted).', shellId);
            return;
          }
          console.error('Failed to close shell:', error);
          toast.error('Could not close the shell', {
            // The pane is already gone from this window — the close was applied
            // optimistically and nothing rolls it back — so the useful half of
            // this message is where the thing they were looking at went.
            description: 'The process may still be running. Reopen it from this session in the sidebar to check.',
          });
        },
      );
    },
    [sessionId],
  );

  /**
   * Close a chat pane: ONE write, and it is the node drop.
   *
   * **This used to send two, and they destroyed the same thing.** The store's
   * `closePane` queues a `drop` that the pump POSTs to `/nodes`, and this
   * function then awaited `DELETE …/conversations/{id}` — whose `expel` is a
   * destroy of that same node. Both take the workspace's advisory lock, the
   * drop normally wins, and the DELETE's expel then finds no node:
   * `not_a_member` → `not_in_session` → 404 → "Could not close this
   * conversation". The pane closed anyway (nothing rolls the drop back), so the
   * toast was pure noise; under lock contention the same race produced the 500
   * variant instead.
   *
   * Making the route idempotent would have silenced it in four lines and left
   * the double-write permanent in a model whose premise is one fact, one
   * writer. The listing is derived from the nodes now
   * (`workspace-conversations-runtime.ts` builds it from
   * `agentWorkspaceNodes WHERE targetKind = 'chat'`; there is no
   * `closedInWorkspaceAt` column left), so the node drop IS the close for the
   * sidebar exactly as it is for the tree, and the DELETE was a second writer
   * for a fact the node write already owns.
   *
   * The directory `conversation:closed` the route used to emit is not lost — it
   * moved INTO the write funnel (`commitUnderLock`), which every producer
   * passes through. It was already not firing for most of them: the drop
   * usually beat the DELETE, so `announceClosed` ran on a branch that was
   * seldom taken, and the sidebar's own row-close never went through the route
   * at all.
   *
   * Synchronous now, and nothing awaits it — so no rebind branch, no catch, no
   * toast on the success path.
   */
  const closeChatPane = useCallback(
    (nodeId: string, conversationId: string) => {
      // `closePane` drops the node, and the node IS the membership — so the
      // switch decision has already stopped seeing this thread by the time this
      // returns. The local cache patch that used to follow is gone with the
      // second listing it kept in step; there is one source now, and this line
      // wrote to it.
      closePane(sessionId, nodeId);
      onConversationClosed?.({ conversationId, next: null, nextAgentPageId: null });
    },
    [sessionId, closePane, onConversationClosed],
  );

  const handleClosePane = useCallback(
    (nodeId: string) => {
      const node = findNode(nodes, nodeId);
      if (node === undefined || node.nodeType !== 'pane') return;
      const decision = decideClosePane({
        panes: paneNodesOf(nodes),
        nodeId,
        activeConversations: closeDecisionListing,
        canEndSession,
      });

      if (decision.action === 'noop') return;

      // ABOVE `beginPaneAssign`, and that placement is the point of putting it
      // here rather than below with the others. That call's own comment says to
      // fire it "only once a decision ACTUALLY commits to altering this node";
      // an end-session raises a confirm and writes nothing, and the user may
      // cancel — which then costs nothing, because nothing was invalidated and
      // nothing was mutated (`onOpenChange(false)` just clears `pendingEnd`).
      if (decision.action === 'end-session') {
        setPendingEnd({ nodeId });
        return;
      }

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
        //
        // BOTH of these now destroy this node — the drop above locally and
        // optimistically, the DELETE's `expel` server-side (#2462) — and unlike
        // the chat double-write below that is not a fact with two writers. It is
        // ONE idempotent removal reached from two directions, which is the rule
        // the kill path is built on: "killing something already gone IS
        // success". Whichever takes the workspace lock second finds the node
        // gone and writes nothing. The optimistic drop is what keeps the pane
        // from sitting there until the round trip and the broadcast come back.
        //
        // **WHERE THAT LEAVES A FAILED KILL, stated because the two directions
        // do not agree there.** If the DELETE answers 502 the server has
        // deliberately unwound its own `expel` to keep the pane — but this
        // window's drop is already queued and will remove it anyway, so the
        // pane goes and the PTY may not. Deferring the drop until the DELETE
        // answered would fix that and cost the close its optimism: the kill
        // retries a sleepy Sprite for up to half a minute, and a Close button
        // that hangs that long is a worse product than a rare wrong outcome.
        // What is owed instead is the truth and a way back, which is why
        // `closeShell`'s toast names the sidebar — the shell ROW survives the
        // unwind, so reopening it there is a real recovery rather than advice.
        if (node.target?.kind === 'terminal') closeShell(node.target.id);
        return;
      }

      closeChatPane(nodeId, decision.conversationId);
    },
    [nodes, closePane, sessionId, closeShell, closeDecisionListing, closeChatPane, beginPaneAssign, canEndSession],
  );

  const confirmEndSession = useCallback(async () => {
    if (!pendingEnd) return;
    // Snapshot the shell (if any) before the tree goes, then assume success: the
    // grid and sidebar row must not wait on the sandbox-kill round trip this
    // DELETE triggers server-side.
    const node = findNode(nodes, pendingEnd.nodeId);
    const shellId = node?.nodeType === 'pane' && node.target?.kind === 'terminal' ? node.target.id : null;
    // The SIDEBAR's row for this workspace, read straight out of SWR's cache
    // rather than through a subscription. This grid has no other use for that
    // listing, and subscribing to it just to hold a rollback snapshot would
    // re-render every pane on the sidebar's poll.
    //
    // SCANNED, not fetched by one key, because the rollback has to REACH as far
    // as the removal does: `forgetWorkspaceInCache` strips this row from every
    // entry `isWorkspaceListingKey` matches, so a snapshot read from a single
    // `agentWorkspacesKey(driveId)` can come back empty for a row that was
    // nonetheless removed — this grid is handed the WORKSPACE's drive, and the
    // listing may well have been fetched under another scope (the reused-global
    // case `agentWorkspacesKey`'s own doc comment warns about) or under none.
    // The row would then be dropped everywhere and restored nowhere, leaving a
    // still-live workspace missing from the sidebar with only the revalidate to
    // bring it back — which `restoreWorkspaceInCache` exists precisely because
    // it cannot be trusted to.
    const sessionEntrySnapshot = findSessionInListingCache(cache, sessionId);
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
  }, [pendingEnd, nodes, sessionId, cache, mutate, forgetWorkspace, closeShell, onSessionEnded]);

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
      // The DELETE's expel destroys the node, and that write goes through the
      // same funnel every other producer does — so `workspace:nodes-updated`
      // lands on `session:<id>`, which this grid is joined to, and the tree
      // drops the member on its own. No local patch: the one source settles
      // itself, and patching beside it would be the second writer this model
      // exists to delete.
      void mutate(isAgentWorkspacesKey);
    },
    [sessionId, closeDecisionListing, isConversationShownSomewhere, onConversationClosed, mutate],
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
        // `activeNodeId` is WHERE, and it is not optional in practice. The mint's
        // own server write admits what it creates, and admitting places — so
        // without a preference the shared policy falls to "the first pane that
        // may be given up", which with two empty panes open is whichever comes
        // first in grid order rather than the one under the user's cursor. The
        // agent would appear in a pane they did not pick and theirs would stay
        // empty. Naming the pane makes the server's placement the user's choice.
        if (agentPageId === null) {
          // The ASSISTANT: no agent page, so the workspace-centric creator is
          // the path (page-agents has no page to hang this on).
          await post(`/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations`, {
            conversationId,
            activeNodeId: nodeId,
          });
        } else {
          await post(`/api/ai/page-agents/${encodeURIComponent(agentPageId)}/conversations`, {
            conversationId,
            sessionId,
            activeNodeId: nodeId,
          });
        }
        const superseded = !isCurrent() || (showsSpinner && !stillMinting(nodeId, mint, conversationId));
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
        // `openConversation` above already placed the node, and the node IS the
        // membership — so this component's own decisions see the mint the
        // instant it happens, with no cache to patch beside it. The thread's
        // AGENT arrives a moment later, on the node write's own ack (the pump
        // adopts the POST's `{rev, nodes, targets}`), and until it does the
        // agent-keyed controls stay disabled rather than guess.
        //
        // The revalidate below is for the SIDEBAR's listing, which is a
        // different consumer with a different scope and still reads the
        // ownership-filtered route.
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
      syncConsoleSelection,
      mutate,
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
            // WHERE, for the same reason a mint says it: the claim ADMITS this
            // thread, and admitting places. Without a preference the policy
            // takes the first pane that qualifies, and the `openConversation`
            // below cannot correct it — by then the thread is already showing
            // somewhere, which that call reads as "focus it there".
            { activeNodeId: nodeId },
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
        // The claim admitted the thread server-side; `openConversation` below
        // places its node locally, and membership IS that node — so there is no
        // listing row to prepend here, and with it goes the `alreadyInSession`
        // special case that existed only because the old patch had no id-based
        // dedupe. The revalidate is the sidebar's.
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
      mutate,
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
    [sessionId, unbindPane, mutate],
  );

  /**
   * The pane bar selector's switch — a two-way decision: the picked agent already
   * has an open conversation somewhere in the workspace (show THAT here), or it
   * does not (mint). Either way, replacing this node's content closes the
   * OUTGOING conversation's listing — the fix for panes silently accumulating
   * stray sidebar rows.
   */
  const handleSwitchAgent = useCallback(
    async (nodeId: string, currentAgentPageId: string | null, nextAgentPageId: string | null) => {
      if (conversationDirectory === null) return;

      // NOTE WHO OWNS THIS PANE, because the MRU re-read below can suspend this
      // handler. It used to be synchronous end to end, so a second pick simply
      // ran after the first; with an await in the middle, an earlier pick can
      // resume AFTER a later one has already placed its choice and apply a
      // decision computed against a tree two selections ago.
      //
      // PEEKED, NOT CLAIMED, and the difference is a deleted conversation. This
      // handler does not yet know whether it will act — `selectPaneAgent` below
      // can still answer `noop`, which is what re-picking the agent a pane
      // already shows returns. A claim taken to find out would invalidate a mint
      // in flight for this same pane, and that mint answers supersession by
      // DELETING the conversation it just created (see `handlePickAgent`) — the
      // pane appearing and then silently vanishing, which is the defect this
      // branch exists to fix. So: observe here, and leave the claiming to
      // `handlePickAgent`, which takes its own on the mint branch below.
      const assignAtEntry = peekPaneAssign(nodeId);

      let candidates = conversationDirectory.resolved;
      // MRU FRESHNESS, bought only where recency can actually decide anything.
      //
      // `findOpenForAgent` picks the most recently active match, and the tree's
      // `lastMessageAt` is only as fresh as the last snapshot: the activity bump
      // that keeps the sidebar's listing live rides the OWNER's
      // `user:<id>:sessions` room, which a member working in someone else's
      // workspace never joins. With one match — the overwhelmingly common
      // case — recency picks nothing, so the switch stays instant. With two or
      // more it is the whole decision, so re-read first.
      if (candidates.filter((candidate) => candidate.agentPageId === nextAgentPageId).length > 1) {
        await useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(sessionId);
        const refreshed = conversationDirectoryOf(useAgentWorkspaceStore.getState().workspaces[sessionId]);
        // A failed re-read is not a reason to refuse the switch: the stale
        // ordering is still a real answer, and it is the one shown on screen.
        if (refreshed !== null) candidates = refreshed.resolved;
        // SOMEBODY TOOK THIS PANE while the re-read was in flight — a newer
        // switch that committed, a History pick, a mint. Whoever it was has
        // already decided; this one must not decide again on top of it. A newer
        // switch that decided `noop` took nothing and is correctly invisible
        // here: it changed the pane no more than this one has.
        if (peekPaneAssign(nodeId) !== assignAtEntry) return;
      }

      const decision = selectPaneAgent({
        sessionConversations: candidates,
        selectedAgentPageId: nextAgentPageId,
        currentAgentPageId,
      });
      if (decision.action === 'noop') return;
      if (decision.action === 'focus-existing') {
        // CLAIM IT, now that a decision has actually committed to altering this
        // node — the rule `decideClosePane` states above, and what makes the
        // guard's "a newer switch that committed" true rather than aspirational.
        // Without it this branch is invisible to the peek: two switches that
        // both take the MRU await, the later one commits, and the earlier one
        // then resumes against an unchanged token and applies its own decision
        // on top — a second DELETE for the outgoing thread, and the console
        // selection dragged back to the agent the user already replaced.
        beginPaneAssign(nodeId);
        // Read LIVE rather than from the closure: an await may have passed
        // above, and the tree can have moved under it.
        const node = findNode(useAgentWorkspaceStore.getState().workspaces[sessionId]?.nodes ?? [], nodeId);
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
      conversationDirectory,
      sessionId,
      openConversation,
      liveConversationIds,
      closeReplacedConversation,
      handlePickAgent,
      syncConsoleSelection,
      beginPaneAssign,
      peekPaneAssign,
    ],
  );

  const handlePickShell = useCallback(
    async (nodeId: string) => {
      const mint: PendingMint = { kind: 'terminal', agentPageId: null };
      beginMint(nodeId, mint);
      try {
        const { shell } = await post<{ shell: { shellId: string; name: string } }>(
          `/api/agent-workspaces/${encodeURIComponent(sessionId)}/shells`,
          // WHERE, for the same reason the chat mint says it: the spawn's own
          // write ADMITS the terminal, and admitting places. Without a
          // preference the policy takes the first pane that qualifies, so with
          // two empty panes the shell opens in the one the user did not click.
          { activeNodeId: nodeId },
        );
        const superseded = !stillMinting(nodeId, mint, shell.shellId);
        endMint(nodeId);
        if (superseded) {
          // The shell exists server-side already, so close it rather than leave
          // it running unattached or clobber whatever this node became. NOT for
          // a pane the spawn's own admission already bound to THIS shell — see
          // `stillMinting`; that is the write landing, and killing the shell
          // there tore down the terminal the user had just watched appear.
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
          conversationsReady={conversationsReady}
          driveId={driveId}
          sessionId={sessionId}
          chatContext={chatContext}
          hostConversationId={hostConversationId}
          isReadOnly={isReadOnly}
          onSelectAgent={(nextAgentPageId) =>
            void handleSwitchAgent(node.id, resolved?.agentPageId ?? null, nextAgentPageId)
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
   * Whether this workspace's conversations are known WELL ENOUGH to decide by
   * agent — the tree has been read from the server, and every thread in it has
   * its per-viewer facts. Short of that the list is indistinguishable from "no
   * conversation with this agent exists yet", and a switch to an agent that
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

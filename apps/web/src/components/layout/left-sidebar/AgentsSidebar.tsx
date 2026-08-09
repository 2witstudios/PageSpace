'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ChevronDown, ChevronRight, FileText, Folder, Plus, Search, SquareTerminal, X } from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { useSWRConfig } from 'swr';

import EndSessionDialog from '@/components/agents/EndSessionDialog';
import { useSpawnSession } from '@/components/agents/useSpawnSession';
import { Input } from '@/components/ui/input';
import { cn, isElectron } from '@/lib/utils';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
import CreateDriveDialog from './CreateDriveDialog';
import DashboardFooter from './DashboardFooter';
import DriveFooter from './DriveFooter';
import PrimaryNavigation from './PrimaryNavigation';
import { SidebarLoading, SidebarNotice } from './sidebar-states';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useDriveStore, type Drive } from '@/hooks/useDrive';
import { canManageDrive } from '@/hooks/usePermissions';
import { usePageAgents, type DriveWithAgents } from '@/hooks/page-agents/usePageAgents';
import { useAgentSurfaceStore, SHEET_BREAKPOINT_QUERY } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import {
  artifactRowsOf,
  conversationPlacement,
  gridPanesOf,
  indexTargets,
  lookupTarget,
  type MemberPlacement,
} from '@/stores/agent-workspace/workspace-tree-view';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceNodeTarget } from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { fetchWithAuth, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import {
  isAgentWorkspacesKey,
  isWorkspaceListingKey,
  forgetWorkspaceInCache,
  forgetConversationInCache,
  restoreWorkspaceInCache,
} from '@/components/agents/panes/workspace-conversations';
import { buildSessionGroups, ASSISTANT_GROUP_KEY } from './session-groups';
import { RowMenu, type RowMenuItem } from './RowMenu';

/**
 * The Agents console's left sidebar: **Drive → Session → Pane.**
 *
 * A SESSION is the tree's second level — a drive-level workspace that owns one
 * sandbox. Agents are NOT a tree level: they are what you pick when spawning
 * a session or a pane.
 *
 * **THE SIDEBAR AND THE PANE GRID ARE TWO RENDERINGS OF ONE TREE.** That is the
 * whole of this epic, arriving here. A workspace's nodes are seated into
 * `useAgentWorkspaceStore` from the listing (see the hydration effect below) and
 * kept live by the owner's own directory-plane broadcast; every row under an
 * expanded session then reads THAT, never the polled snapshot it came in on.
 * Nothing is synchronised, because there is only one structure.
 *
 * Two consequences worth stating, because both were bugs:
 *
 *  - A pane an agent placed appears when its broadcast lands rather than up to
 *    two minutes later, which is the symptom the epic opened with.
 *  - Every member is visible, INCLUDING the ones that are not on screen. A
 *    thread with no node at all is listed (its row comes from the conversation
 *    listing, which is its membership), and a node with no parent — parked, in
 *    the workspace, off the grid — is listed too, dimmed. Rendering only what is
 *    attached would reintroduce #2373 exactly: in production one workspace
 *    showed 2 of its 3 threads and another 4 of its 10.
 *
 * Two modes, one component:
 * - **Drive-scoped** (`driveId` present): that drive's sessions.
 * - **Global** (`/dashboard/agents`): every accessible drive's sessions,
 *   grouped under a drive header.
 *
 * **Clicking a row does not navigate.** Selection goes to
 * `useAgentSurfaceStore`, which mirrors it to `?workspace=&c=&agent=` via
 * `pushState`. The route never changes, so nothing above or beside this
 * component remounts, so live shells and streaming chats survive every click.
 */
export default function AgentsSidebar({ className }: SidebarProps) {
  const params = useParams();
  const [isElectronMac, setIsElectronMac] = useState(false);
  const isSheetBreakpoint = useBreakpoint(SHEET_BREAKPOINT_QUERY);

  const driveIdParams = params?.driveId;
  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;

  const drives = useDriveStore((state) => state.drives);
  const drive = drives.find((d) => d.id === driveId);
  const canManage = canManageDrive(drive);

  const { user, isLoading: authLoading } = useAuth();
  // Sessions/chat/panes are open to every authenticated user — only the
  // sandbox itself (real cloud compute) is tier-gated, further down, on the
  // terminal affordance inside a session. The fetch key is still gated on
  // authentication (not a role): a surface with nothing to show while auth
  // is still resolving has no business fetching yet either.
  const isAuthenticated = Boolean(user);

  const sessionsKey = isAuthenticated
    ? driveId
      ? `/api/agent-workspaces?driveId=${encodeURIComponent(driveId)}`
      : '/api/agent-workspaces'
    : null;
  const {
    data,
    error: sessionsError,
    isLoading: sessionsLoading,
    mutate: retrySessions,
  } = useSWR<{ sessions: SessionListEntry[] }>(sessionsKey, sessionsFetcher, {
    revalidateOnFocus: false,
    // BACKSTOP, not the mechanism (Agent-Session SSoT epic, Phase 2 / plan PR 4).
    // Session/conversation rows change on spawn and end, which other tabs and
    // agents can do — and those changes now ARRIVE, as
    // `conversation:created/updated/closed/reopened/deleted` and `session:*` on the
    // owner's `user:<id>:sessions` room, applied to this cache by
    // `session-directory-listener.ts`. The poll only catches a broadcast lost
    // outright. Demoted from 20s to 120s; SLATED FOR DELETION at the epic's final
    // contract PR.
    refreshInterval: 120_000,
  });

  // Unfiltered (no driveId arg) in BOTH modes now, not just global mode: a
  // drive's sidebar can show a global-assistant session whose conversations
  // are with agents from ANY accessible drive (agent-workspaces-store.ts's
  // `list()` now surfaces those), so `agentNamesById` below needs every
  // accessible agent's name, not just this drive's, to label them correctly
  // instead of falling back to the generic "Agent" (review: Codex P2 on
  // #2325). The spawn palette stays correctly drive-scoped regardless —
  // `useSpawnSession` already does its own `agentsByDrive.find(entry =>
  // entry.driveId === spawnTarget.driveId)` lookup, so handing it the full
  // list changes nothing about which agents a drive's "+" offers. Gated on
  // authentication, not the retired admin role — sessions are open to every
  // authenticated user now (#2326).
  const { agentsByDrive } = usePageAgents(undefined, { enabled: isAuthenticated });

  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

  // SEAT EVERY LISTED WORKSPACE'S TREE. This is the sidebar's only write to the
  // store's structural half, and after it the rows render from the store alone —
  // so a broadcast, a pane the user opened in another tab, and this poll all
  // reach the sidebar through one path instead of three.
  //
  // It runs on every revalidation, which is exactly why `hydrateFromServer` has
  // a no-op early-out: same rev, a base already held, nothing local outstanding
  // and identical titles means it returns without touching state, so an
  // unchanged workspace does not re-render its tree twice a minute.
  useEffect(() => {
    if (!data) return;
    const store = useAgentWorkspaceStore.getState();
    for (const session of data.sessions) {
      store.hydrateFromServer(session.workspaceId, {
        rev: session.rev,
        nodes: session.nodes,
        targets: session.targets,
      });
    }
  }, [data]);

  return (
    <aside
      className={cn(
        'flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden',
        className
      )}
    >
      <div className="flex h-full flex-col px-3 py-3">
        <div className={cn('mb-3', isElectronMac && isSheetBreakpoint && 'pl-[60px]')}>
          <DriveSwitcher />
        </div>

        <PrimaryNavigation driveId={driveId} />

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none">
          <div className="space-y-0.5">
            <SessionList
              authLoading={authLoading}
              isAuthenticated={isAuthenticated}
              driveId={driveId}
              drives={drives}
              sessions={data?.sessions ?? []}
              isLoading={sessionsLoading && !data}
              hasError={!!sessionsError}
              onRetry={() => void retrySessions()}
              agentsByDrive={agentsByDrive}
              onChanged={() => void retrySessions()}
            />
          </div>
        </div>

        {driveId ? <DriveFooter canManage={canManage} /> : <DashboardFooter />}
      </div>
    </aside>
  );
}

interface SessionConversationEntry {
  conversationId: string;
  title: string | null;
  agentPageId: string | null;
}

interface SessionListEntry {
  /**
   * `agent_workspaces.id` — the CANONICAL field, not the `sessionId` compat
   * twin the DTO still carries for the rolling-deploy window. That one is
   * documented as "nothing new may read it", and this file held 38 of the
   * reads.
   */
  workspaceId: string;
  driveId: string | null;
  name: string;
  sandboxStatus: 'none' | 'starting' | 'running' | 'ended';
  conversations: SessionConversationEntry[];
  shells: Array<{ shellId: string; name: string }>;
  /**
   * THE TREE, as of this read — seated into `useAgentWorkspaceStore` and then
   * never read from here again.
   *
   * The rows below render the STORE, not this. That is the whole of item 4: a
   * polled snapshot is up to 120 seconds old, and the row's menu used to read it
   * while the row's close action read the store, so the two could disagree about
   * whether "Close" meant "take this off the screen" or "close the thread". One
   * read, one answer, and the answer updates the instant a broadcast lands
   * rather than at the next poll.
   */
  rev: number;
  nodes: WorkspaceNode[];
  targets: WorkspaceNodeTarget[];
}

/** The sessions list changed — revalidate. */
type OnSessionsChanged = () => void;

async function sessionsFetcher(url: string): Promise<{ sessions: SessionListEntry[] }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to list sessions (${response.status})`);
  return response.json();
}

/**
 * The one ordering-sensitive guard chain the list needs — auth-pending and
 * unauthenticated first, loading ahead of error (a Retry click must show
 * loading, not a rerun of the failure text), error ahead of empty (SWR's
 * error path is indistinguishable from empty unless checked first), and a
 * background poll's error never tears down a list the caller already has.
 *
 * `isDataEmpty` and `isResultEmpty` are deliberately separate: the error
 * branch must key off the raw fetch result (`isDataEmpty`) so a background
 * refresh failure on a drive with cached sessions never reads as "failed to
 * load" just because the current search happens to match nothing — that case
 * belongs to the plain empty-result branch (`isResultEmpty`) instead.
 */
export function resolveListNotice({
  authLoading,
  isAuthenticated,
  hasError,
  isLoading,
  isDataEmpty,
  isResultEmpty,
  emptyTitle,
  onRetry,
}: {
  authLoading: boolean;
  isAuthenticated: boolean;
  hasError: boolean;
  isLoading: boolean;
  isDataEmpty: boolean;
  isResultEmpty: boolean;
  emptyTitle: string;
  onRetry: () => void;
}): React.ReactNode {
  if (authLoading) return <SidebarLoading message="Loading…" />;
  // Sessions/chat/panes are open to every authenticated user now — this only
  // fires for a genuinely signed-out edge case (e.g. mid-logout, an expired
  // session), not a role restriction.
  if (!isAuthenticated) return <SidebarNotice title="Sign in to view your sessions" />;
  if (isLoading) return <SidebarLoading message="Loading sessions…" />;
  if (hasError && isDataEmpty) {
    return (
      <SidebarNotice
        title="Failed to load sessions"
        description="Check your connection and try again."
        tone="destructive"
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  if (isResultEmpty) return <SidebarNotice title={emptyTitle} />;
  return null;
}

function SessionList({
  authLoading,
  isAuthenticated,
  driveId,
  drives,
  sessions,
  isLoading,
  hasError,
  onRetry,
  agentsByDrive,
  onChanged,
}: {
  authLoading: boolean;
  isAuthenticated: boolean;
  driveId: string | undefined;
  drives: Drive[];
  sessions: SessionListEntry[];
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  agentsByDrive: DriveWithAgents[];
  onChanged: OnSessionsChanged;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedQuery = searchQuery.trim();
  const hasSearch = trimmedQuery.length > 0;

  const canSpawn = isAuthenticated && !authLoading;

  // The roster — every drive the user can work in, whether or not it has a
  // live session — is the canonical drive-group source in global mode. Not
  // `agentsByDrive`: that fetch's drive enumeration is an implementation
  // detail of the multi-drive agents feature, and coupling the sidebar's
  // drive list to it would regress silently if that feature's shape changes.
  // Empty for a non-admin (or while auth is still resolving): this is a
  // refusal-only surface for them, and `useDriveStore` can otherwise hold
  // trashed drives too — `useGlobalDriveSocket` refetches with
  // `includeTrash: true` on drive events — so those are filtered out to match
  // DriveSwitcher and the multi-drive agents API, both active-drives-only.
  const roster = useMemo(
    () => (canSpawn ? drives.filter((d) => !d.isTrashed).map((d) => ({ driveId: d.id, driveName: d.name })) : []),
    [canSpawn, drives],
  );

  // A trashed drive with a lingering session becomes an orphan group (it's
  // excluded from the roster above) — it must still surface its existing
  // session, but must not offer to spawn a NEW one into a trashed drive.
  const trashedDriveIds = useMemo(() => new Set(drives.filter((d) => d.isTrashed).map((d) => d.id)), [drives]);

  // Flattened once here (not per-SessionRow) so every session's conversation
  // labels share one lookup instead of re-deriving it from `agentsByDrive` N
  // times.
  const agentNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const drive of agentsByDrive) {
      for (const agent of drive.agents) {
        map.set(agent.id, agent.title ?? 'Agent');
      }
    }
    return map;
  }, [agentsByDrive]);

  // Search filters by session name only, client-side, no debounce — same
  // idiom as PageTree's filterTree.
  const filteredSessions = useMemo(() => {
    if (!hasSearch) return sessions;
    const query = trimmedQuery.toLowerCase();
    return sessions.filter((session) => (session.name || 'Session').toLowerCase().includes(query));
  }, [sessions, hasSearch, trimmedQuery]);

  const notice = resolveListNotice({
    authLoading,
    isAuthenticated,
    hasError,
    isLoading,
    isDataEmpty: sessions.length === 0,
    isResultEmpty: filteredSessions.length === 0,
    emptyTitle: hasSearch
      ? 'No sessions match your search'
      : driveId
        ? 'No sessions in this drive yet'
        : 'No sessions yet',
    onRetry,
  });

  // Group by drive in global mode (roster ∪ session-implied drives, Assistant
  // first — see session-groups.ts for the ordering rule). In drive mode, the
  // drive's own sessions get an always-present implicit group (even with zero
  // sessions, so its header's spawn affordance never disappears mid-load).
  // A second "Global Assistant" group, ahead of it (same "Assistant first"
  // rule as global mode), surfaces the caller's global sessions (driveId
  // null) — those aren't this drive's data, they're the user's, and the API
  // now includes them in every drive-scoped listing (see
  // agent-workspaces-store.ts's `list()`) — but ONLY when there's at least one:
  // unlike global mode's Assistant group, this one has no `canSpawn`
  // always-show escape hatch, because "Global Assistant" already names a
  // different, unrelated affordance in drive mode: the new-session drive
  // palette's own "Global Assistant" agent-picker entry
  // (`useSpawnSession.tsx`'s `onPickTarget({ kind: 'assistant', ... label:
  // 'Global Assistant' })`), which spawns a DRIVE-scoped session whose first
  // conversation happens to be with the assistant agent — an
  // always-rendered empty group here would sit right next to that and read
  // as the same thing when it is not.
  const groups = useMemo(() => {
    if (driveId) {
      // Same bucketing/ordering `buildSessionGroups` already does for global
      // mode, just handed a single-drive roster — `assistant: false` is what
      // encodes "no canSpawn escape hatch" above (`hasAssistantSessions`
      // still shows the group once one exists).
      const driveName = drives.find((d) => d.id === driveId)?.name ?? driveId;
      return buildSessionGroups(filteredSessions, { assistant: false, drives: [{ driveId, driveName }] });
    }
    return buildSessionGroups(filteredSessions, { assistant: canSpawn, drives: roster });
  }, [driveId, filteredSessions, drives, canSpawn, roster]);

  // While actively searching, a group with no matches is noise — hide it
  // rather than showing an empty group with a spawn "+". Outside search the
  // roster still forces every group to render (even with zero sessions) so
  // its spawn affordance never disappears mid-load.
  const visibleGroups = useMemo(
    () => (hasSearch ? groups.filter((group) => group.sessions.length > 0) : groups),
    [groups, hasSearch],
  );

  const [createDriveOpen, setCreateDriveOpen] = useState(false);
  const { openSpawn, openAssistantSpawn, paletteElement } = useSpawnSession(agentsByDrive, onChanged);

  // Sessions are always deliberately named now — both groups open the same
  // naming step. The ASSISTANT group has nothing to pick (the assistant IS
  // the counterpart), so it skips straight to naming; a DRIVE group's "+"
  // opens the picker first so the naming step's placeholder can reflect
  // whichever agent/shell was chosen.
  const handleNewSession = useCallback(
    (groupDriveId: string, groupDriveName: string | null) => {
      if (groupDriveId === ASSISTANT_GROUP_KEY) {
        openAssistantSpawn();
        return;
      }
      openSpawn(groupDriveId, groupDriveName);
    },
    [openSpawn, openAssistantSpawn],
  );

  return (
    <div className="space-y-1">
      {canSpawn && (
        <SessionSearchHeader
          value={searchQuery}
          onChange={setSearchQuery}
          onAction={driveId ? () => handleNewSession(driveId, null) : () => setCreateDriveOpen(true)}
          actionLabel={driveId ? 'New session' : 'New drive'}
        />
      )}
      {visibleGroups.map((group) => (
        <div key={group.driveId}>
          {/* `group.driveId` is always a real string (never undefined), so
              this alone already covers global mode (every group differs from
              an undefined `driveId`) — no separate `!driveId ||` needed. */}
          {group.driveId !== driveId && (
            <SessionGroupHeader
              label={group.driveName ?? group.driveId}
              newSessionLabel={`New session in ${group.driveName ?? 'this drive'}`}
              onNewSession={
                trashedDriveIds.has(group.driveId)
                  ? undefined
                  : () => handleNewSession(group.driveId, group.driveName)
              }
            />
          )}
          {group.sessions.map((session) => (
            <SessionRow key={session.workspaceId} session={session} agentNamesById={agentNamesById} />
          ))}
        </div>
      ))}
      {notice}
      {paletteElement}
      {!driveId && <CreateDriveDialog isOpen={createDriveOpen} setIsOpen={setCreateDriveOpen} />}
    </div>
  );
}

/** The search+"+" row atop the list: search filters sessions by name; "+" spawns a new session (drive-scoped) or creates a new drive (global). Replaces the old static "Agent Sessions" label. */
function SessionSearchHeader({
  value,
  onChange,
  onAction,
  actionLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onAction: () => void;
  actionLabel: string;
}) {
  return (
    <div className="flex items-center gap-1 pl-2 pr-4 pb-1 pt-1.5">
      <div className="relative flex-1">
        <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search sessions…"
          aria-label="Search sessions"
          className="h-7 pl-6 text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <button
        type="button"
        aria-label={actionLabel}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onAction}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/** A group's header row: drive name plus an inline "+" spawn affordance — condensed in place of a separate full-width row. */
function SessionGroupHeader({
  label,
  newSessionLabel,
  onNewSession,
}: {
  label: string;
  newSessionLabel?: string;
  onNewSession?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-1 pl-2 pr-4 pb-0.5 pt-1.5">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold text-foreground">
        <Folder className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      {onNewSession && (
        <button
          type="button"
          aria-label={newSessionLabel ?? 'New session'}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onNewSession}
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * One session: name + running dot, expanding to THE WORKSPACE'S MEMBERS —
 * threads, page panes and shells.
 *
 * **It renders the LIVE TREE, out of `useAgentWorkspaceStore`.** The listing
 * seats that tree (see the hydration effect above) and is then not consulted for
 * structure again. Two things follow, and both are the point of the epic:
 *
 *  - A pane an agent placed shows up when the broadcast lands, not when the
 *    120-second poll next fires.
 *  - The row's MENU and the row's ACTION read the same state. They used to read
 *    two — a server annotation and the store — so a thread could be listed as
 *    placed while the store knew its pane was gone, and "Close" then meant two
 *    different things depending on which half you asked.
 */
function SessionRow({
  session,
  agentNamesById,
}: {
  session: SessionListEntry;
  agentNamesById: Map<string, string>;
}) {
  // Bound to whatever `SWRConfig` provider wraps this tree (the app's default
  // cache in production, an isolated one in tests) — NOT the bare top-level
  // `mutate` import, which only ever targets SWR's default cache and would
  // silently no-op under a custom provider.
  const { mutate } = useSWRConfig();
  const selectedSessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectedConversationId = useAgentSurfaceStore((state) => state.selectedConversationId);
  const selectedAgentId = useAgentSurfaceStore((state) => state.selectedAgentId);
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const forgetWorkspace = useAgentWorkspaceStore((state) => state.forgetWorkspace);
  const closePane = useAgentWorkspaceStore((state) => state.closePane);
  const showNode = useAgentWorkspaceStore((state) => state.showNode);

  // THE WORKSPACE OBJECT, selected whole. Never a filter inlined here: a
  // selector that derives a fresh array on every call defeats `Object.is`, so
  // zustand sees a change on every store write anywhere and the subscription
  // loops. Every derivation below is a `useMemo` over this one reference.
  const tree = useAgentWorkspaceStore((state) => state.workspaces[session.workspaceId]);

  const [expanded, setExpanded] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const isSelected = selectedSessionId === session.workspaceId;
  const isRunning = session.sandboxStatus === 'running' || session.sandboxStatus === 'starting';

  /**
   * THE PAGE AND SHELL ARTIFACTS THIS WORKSPACE HOLDS — attached AND detached.
   *
   * The detached half is the #2373 guard restated in the model that replaced it.
   * The old bug was a fork (grid or thread list) in which the grid always won, so
   * an unplaced thread was invisible; the flat model deletes the fork and hands
   * back the same trap in a new shape, because a renderer that walks from the
   * root sees only what is on screen and a parked node is precisely a member that
   * is not. `artifactRowsOf` walks the flat list.
   */
  const artifactRows = useMemo(() => (tree ? artifactRowsOf(tree) : []), [tree]);

  /**
   * Every thread in this workspace, each annotated with where its node sits.
   *
   * The THREAD is the row and the node is an attribute of it — a thread with no
   * node at all is a legitimate resting state (placement is best-effort, and a
   * thread created without `placeInGrid` is never placed), so this list is keyed
   * by the listing and never by the tree. What the tree decides is only the
   * annotation, and it decides it LIVE.
   */
  const conversationRows = useMemo(
    () =>
      session.conversations.map((conversation) => ({
        conversation,
        ...conversationPlacement(tree, conversation.conversationId),
      })),
    [session.conversations, tree],
  );

  const openConversation = useCallback(
    (conversation: SessionConversationEntry) => {
      selectConversation({
        sessionId: session.workspaceId,
        conversationId: conversation.conversationId,
        agentId: conversation.agentPageId,
      });
    },
    [selectConversation, session.workspaceId],
  );

  const openShell = useCallback(
    (shell: { shellId: string; name: string }) => {
      selectSession(session.workspaceId);
      // The store's placement policy owns the rest, including the case this used
      // to hand-roll: a shell already bound to a PARKED node is brought back
      // rather than opened a second time. `liveConversationIds` protects a chat
      // pane showing a thread closed out of the workspace from being displaced
      // by an unrelated shell reattach (issue #2295).
      useAgentWorkspaceStore.getState().openShell(session.workspaceId, shell.shellId, {
        liveConversationIds: new Set(session.conversations.map((c) => c.conversationId)),
      });
    },
    [selectSession, session.workspaceId, session.conversations],
  );

  const openSession = useCallback(() => {
    // Selecting a SESSION opens its most recent work — the row is a workspace,
    // and a workspace opens on its work, not on a placeholder. The ACTIVE pane
    // first (falling back to the first chat pane in the grid), then a page pane,
    // then any listed thread, then a shell.
    setExpanded(true);
    if (tree) {
      const index = indexTargets(tree.targets);
      const panes = gridPanesOf(tree.nodes);
      const active = panes.find((pane) => pane.id === tree.activeNodeId);
      const chatPane =
        (active?.target?.kind === 'chat' ? active : undefined) ??
        panes.find((pane) => pane.target?.kind === 'chat');
      if (chatPane?.target?.kind === 'chat') {
        const conversationId = chatPane.target.id;
        selectConversation({
          sessionId: session.workspaceId,
          conversationId,
          // From `targets[]`, which resolved it behind the same gate the title
          // passed — the listing's own row is the fallback for a thread this
          // viewer cannot name.
          agentId:
            lookupTarget(index, chatPane)?.agentPageId ??
            session.conversations.find((c) => c.conversationId === conversationId)?.agentPageId ??
            null,
        });
        return;
      }
      // No chat pane at all — a page-only grid still opens on its work: focus
      // the active page pane rather than re-seeding a conversation over it.
      const pagePane = (active?.target?.kind === 'page' ? active : undefined) ?? panes.find((pane) => pane.target?.kind === 'page');
      if (pagePane) {
        selectSession(session.workspaceId);
        useAgentWorkspaceStore.getState().selectNode(session.workspaceId, pagePane.id);
        return;
      }
    }
    const first = session.conversations[0];
    if (first) {
      openConversation(first);
      return;
    }
    const firstShell = session.shells[0];
    if (firstShell) openShell(firstShell);
  }, [tree, openConversation, openShell, selectConversation, selectSession, session.workspaceId, session.conversations, session.shells]);

  const endSession = useCallback(async () => {
    // Assume success immediately — the row must not linger in the sidebar for
    // however long the sandbox-kill round trip this DELETE triggers server-side
    // actually takes. `session` (the prop) IS this row's own current cache entry,
    // so it doubles as the snapshot to restore on failure.
    const wasSelected = selectedSessionId === session.workspaceId;
    const previousConversationId = selectedConversationId;
    const previousAgentId = selectedAgentId;
    // The workspace leaves the sidebar; its conversations remain as history in
    // each agent's list. Drop the local tree too — its panes pointed at a
    // sandbox that no longer exists.
    forgetWorkspace(session.workspaceId);
    if (wasSelected) selectSession(null);
    setConfirmingEnd(false);
    forgetWorkspaceInCache(mutate, session.workspaceId);
    try {
      await del(`/api/agent-workspaces/${encodeURIComponent(session.workspaceId)}`);
    } catch (error) {
      // The optimistic assumption was wrong. Restore the row LOCALLY (a real
      // revalidate alone isn't enough: it rides the same network whose failure is
      // plausibly why the DELETE failed, so it could easily fail too and leave
      // the row missing indefinitely) and re-read the tree, which the store no
      // longer keeps a snapshot of — the server's copy is the only honest one.
      restoreWorkspaceInCache(mutate, session);
      void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(session.workspaceId);
      // Selection restore, and only if NOTHING has claimed it since:
      // `selectConversation`/`selectSession` also push a URL, so blindly
      // restoring would yank the user back here even if they have navigated
      // elsewhere during the round trip. Via `selectConversation` with the FULL
      // previous trio — `selectSession` alone compares against the NOW-cleared
      // `null` and would drop the conversation and agent with it.
      if (wasSelected && useAgentSurfaceStore.getState().selectedSessionId === null) {
        selectConversation({
          sessionId: session.workspaceId,
          conversationId: previousConversationId,
          agentId: previousAgentId,
        });
      }
      void mutate(isWorkspaceListingKey);
      console.error('Failed to end session:', error);
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      return;
    }
    // Confirmed — background reconcile only; the tree and sidebar are already right.
    void mutate(isWorkspaceListingKey);
  }, [
    forgetWorkspace,
    mutate,
    selectConversation,
    selectSession,
    selectedAgentId,
    selectedConversationId,
    selectedSessionId,
    session,
  ]);

  const closeConversation = useCallback(
    async (conversationId: string) => {
      try {
        await del(
          `/api/agent-workspaces/${encodeURIComponent(session.workspaceId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          // The workspace's LAST open listing — the server is the authority on
          // the never-empty invariant; fall back to the same confirmed
          // end-session flow the row's own "End session" already uses.
          setConfirmingEnd(true);
          return;
        }
        console.error('Failed to close this conversation:', error);
        toast.error('Could not close this conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        return;
      }
      // Instant sidebar freshness — a local cache patch instead of a full
      // revalidate, so the row leaves the listing without a second, sequential
      // network round trip on top of the DELETE that just resolved.
      forgetConversationInCache(mutate, session.workspaceId, conversationId);
      void mutate(isAgentWorkspacesKey);
    },
    [mutate, session.workspaceId],
  );

  /**
   * What "Close" means for one thread's row — decided from the SAME live tree
   * the menu label was decided from.
   *
   * On the grid, Close takes it off the screen and leaves it in the workspace:
   * the node parks, the row stays, one click brings it back. Off the grid there
   * is nothing left to take away, so Close means the thread's listing.
   *
   * The old version had to seat a snapshot first (`ensureLocalWorkspace`), because
   * a row could act on a workspace whose grid was never mounted and a raw store
   * read came back undefined — at which point "close this pane" silently became
   * "DELETE this conversation". Every listed workspace is seated now, on every
   * revalidation, so there is no such gap; and if `tree` is somehow absent the
   * placement reads `unplaced`, which closes the LISTING rather than guessing.
   */
  const closeConversationRow = useCallback(
    (conversationId: string, placement: MemberPlacement, nodeId: string | null) => {
      if (placement === 'grid' && nodeId !== null) {
        closePane(session.workspaceId, nodeId);
        return;
      }
      void closeConversation(conversationId);
    },
    [closePane, closeConversation, session.workspaceId],
  );

  const conversationLabel = useCallback(
    (conversation: SessionConversationEntry) => {
      const agentName =
        conversation.agentPageId === null
          ? 'Global Assistant'
          : (agentNamesById.get(conversation.agentPageId) ?? 'Agent');
      return conversation.title ? `${agentName} — ${conversation.title}` : agentName;
    },
    [agentNamesById],
  );

  const menuItems: RowMenuItem[] = useMemo(
    () => [
      {
        label: 'End session',
        icon: X,
        onSelect: () => setConfirmingEnd(true),
        destructive: true,
      },
    ],
    [],
  );

  const openArtifact = useCallback(
    (nodeId: string, placement: MemberPlacement) => {
      selectSession(session.workspaceId);
      // A parked node is brought back onto the grid; one already there is only
      // focused. `showNode` is both, and it is the only affordance a parked row
      // has — without it, clicking one would silently do nothing, which is the
      // #2373 symptom wearing a new hat.
      if (placement === 'parked') showNode(session.workspaceId, nodeId);
      else useAgentWorkspaceStore.getState().selectNode(session.workspaceId, nodeId);
    },
    [selectSession, showNode, session.workspaceId],
  );

  return (
    // Per-session test handle, wrapping BOTH the session's own row and its
    // expanded children — so an end-to-end spec can scope "this session's
    // conversation rows" without depending on which other sessions happen to be
    // expanded.
    <div data-testid={`sidebar-session-${session.workspaceId}`}>
      <RowMenu
        items={menuItems}
        menuLabel="Session actions"
        className={cn('gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent', isSelected && 'bg-accent')}
      >
        <button
          type="button"
          aria-label={expanded ? `Collapse ${session.name || 'session'}` : `Expand ${session.name || 'session'}`}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={openSession}>
          {isRunning && (
            // `role="img"` gives the span an accessible-name-bearing role — a
            // plain `<span aria-label>` is not announced by most screen readers,
            // since aria-label is only honoured on elements with a role that
            // supports naming.
            <span
              role="img"
              aria-label="Sandbox running"
              className="size-1.5 shrink-0 rounded-full bg-emerald-500"
            />
          )}
          <span className="truncate text-muted-foreground">{session.name || 'Session'}</span>
        </button>
        <button
          type="button"
          aria-label="End session"
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          onClick={() => setConfirmingEnd(true)}
        >
          <X className="size-3.5" />
        </button>
      </RowMenu>

      <EndSessionDialog
        open={confirmingEnd}
        onOpenChange={setConfirmingEnd}
        sessionName={session.name}
        onConfirm={() => void endSession()}
      />

      {expanded && (
        <div className="ml-4 space-y-0.5 border-l border-border pl-1.5">
          {conversationRows.map(({ conversation, placement, nodeId }) => (
            <ConversationRow
              key={conversation.conversationId}
              placement={placement}
              label={conversationLabel(conversation)}
              isSelected={selectedConversationId === conversation.conversationId}
              onOpen={() => openConversation(conversation)}
              onClose={() => closeConversationRow(conversation.conversationId, placement, nodeId)}
            />
          ))}
          {artifactRows.map((row) => (
            <RowMenu
              key={row.key}
              items={[
                {
                  label: row.placement === 'grid' ? 'Close' : 'Show',
                  icon: X,
                  onSelect: () =>
                    row.nodeId === null
                      ? undefined
                      : row.placement === 'grid'
                        ? closePane(session.workspaceId, row.nodeId)
                        : openArtifact(row.nodeId, row.placement),
                  destructive: row.placement === 'grid',
                },
              ]}
              menuLabel="Page pane actions"
              className={cn(
                'gap-1.5 rounded-md px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground',
                row.placement === 'parked' ? 'text-muted-foreground/60' : 'text-muted-foreground',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => (row.nodeId === null ? undefined : openArtifact(row.nodeId, row.placement))}
                // The one visual difference a parked row needs. It is a member of
                // the workspace that is not on the screen, and saying so is what
                // stops "why is this here?" being the reaction to the row that
                // exists to prevent the thing being lost.
                title={row.placement === 'parked' ? `${row.title} (not open)` : row.title}
              >
                <FileText className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{row.title}</span>
              </button>
            </RowMenu>
          ))}
          {session.shells.map((shell) => (
            <button
              key={shell.shellId}
              type="button"
              className="flex min-w-0 w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => openShell(shell)}
            >
              <SquareTerminal className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{shell.name}</span>
            </button>
          ))}
          {session.conversations.length === 0 && artifactRows.length === 0 && session.shells.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No conversations</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ONE THREAD'S ROW — the single shape the workspace expansion renders for a
 * conversation (issue #2373).
 *
 * There used to be two: a pane-keyed row when the workspace had a grid, and a
 * conversation-keyed row when it did not. That fork is what made an unplaced
 * thread invisible, because an open workspace always has a grid. The row is
 * keyed by the THREAD, and its node — when it has one — decides only what Close
 * does.
 *
 * `placement` comes from the LIVE tree, so the label the user reads and the act
 * the click performs are the same decision. It also makes the third state
 * VISIBLE for the first time: a thread whose pane was closed is `parked`, still
 * a member, still one click from coming back — and dimming it is how the sidebar
 * says "in this workspace, not on your screen" instead of leaving the user to
 * infer it from a row that looks identical to an open one.
 */
function ConversationRow({
  placement,
  label,
  isSelected,
  onOpen,
  onClose,
}: {
  placement: MemberPlacement;
  label: string;
  isSelected: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <RowMenu
      items={[
        {
          // On the grid, Close takes it off the screen. Off it, there is nothing
          // left to take away, so Close means the thread.
          label: placement === 'grid' ? 'Close pane' : 'Close conversation',
          icon: X,
          onSelect: onClose,
          destructive: true,
        },
      ]}
      menuLabel="Conversation actions"
      testId="sidebar-conversation-row"
      data-placement={placement}
      className={cn(
        'gap-1.5 rounded-md px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground',
        placement === 'grid' ? 'text-muted-foreground' : 'text-muted-foreground/60',
        isSelected && 'bg-accent text-foreground',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center text-left"
        onClick={onOpen}
        title={placement === 'grid' ? label : `${label} (not open)`}
      >
        <span className="truncate">{label}</span>
      </button>
    </RowMenu>
  );
}

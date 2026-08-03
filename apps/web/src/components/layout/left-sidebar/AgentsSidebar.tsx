'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Folder, Plus, Search, SquareTerminal, X } from 'lucide-react';
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
import { panesOf, isLastPane, type PaneState } from '@/stores/agent-workspace/pane-reducer';
import { fetchWithAuth, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import type { PersistedWorkspaceState } from '@pagespace/lib/agent-sessions/contract';
import {
  isAgentSessionsKey,
  forgetSessionInCache,
  forgetConversationInCache,
} from '@/components/agents/panes/session-conversations';
import { buildSessionGroups, ASSISTANT_GROUP_KEY } from './session-groups';
import { RowMenu, type RowMenuItem } from './RowMenu';

/**
 * The Agents console's left sidebar: **Drive → Session → Pane.**
 *
 * A SESSION is the tree's second level — a drive-level workspace that owns one
 * sandbox. Agents are NOT a tree level: they are what you pick when spawning
 * a session or a pane.
 *
 * PANES ARE listed here now — a reversal of this file's earlier stance (the
 * old sidebar's `WorkspaceLeaves` pattern was deliberately not restored, back
 * when a pane was purely local, ephemeral browser state with nothing
 * server-durable to show). Panes are now server-persisted
 * (`agent_sessions.workspaceState`, synced by `useWorkspaceServerSync`), so a
 * session's expansion shows one row per PANE, labelled by its own
 * conversation — this is what actually fixes "switching a pane's agent
 * spawns a new sidebar item instead of updating the one I was looking at":
 * the pane's OWN row now updates in place.
 *
 * `session.workspace` is `null` for a session never opened under this
 * feature (or opened only by an older client) — that session's expansion
 * falls back to the flat `session.conversations` list this sidebar always
 * rendered, unchanged.
 *
 * Two modes, one component:
 * - **Drive-scoped** (`driveId` present): that drive's sessions.
 * - **Global** (`/dashboard/agents`): every accessible drive's sessions,
 *   grouped under a drive header.
 *
 * **Clicking a row does not navigate.** Selection goes to
 * `useAgentSurfaceStore`, which mirrors it to `?session=&c=&agent=` via
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
  // Sandboxes are admin-only end to end, and this console is the surface for
  // them — so a non-admin gets the refusal, not a list. The gate is a DISABLED
  // SWR KEY rather than a render-time check: a surface that will refuse to show
  // the list has no business fetching it either.
  const isAdmin = user?.role === 'admin';

  const sessionsKey = isAdmin
    ? driveId
      ? `/api/agent-sessions?driveId=${encodeURIComponent(driveId)}`
      : '/api/agent-sessions'
    : null;
  const {
    data,
    error: sessionsError,
    isLoading: sessionsLoading,
    mutate: retrySessions,
  } = useSWR<{ sessions: SessionListEntry[] }>(sessionsKey, sessionsFetcher, {
    revalidateOnFocus: false,
    // Modest poll: session/conversation rows change on spawn and end, which
    // other tabs and agents can do. The pane grid itself never lives here.
    refreshInterval: 20_000,
  });

  // The spawn chooser's agent list rides the same fetch both modes already use.
  const { agentsByDrive } = usePageAgents(driveId, { enabled: isAdmin });

  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

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
              isAdmin={isAdmin}
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
  sessionId: string;
  driveId: string | null;
  name: string;
  sandboxStatus: 'none' | 'starting' | 'running' | 'ended';
  conversations: SessionConversationEntry[];
  shells: Array<{ shellId: string; name: string }>;
  /** The saved pane grid — `null` for a session never opened under `useWorkspaceServerSync`. */
  workspace: PersistedWorkspaceState | null;
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
 * non-admin first, loading ahead of error (a Retry click must show loading, not
 * a rerun of the failure text), error ahead of empty (SWR's error path is
 * indistinguishable from empty unless checked first), and a background poll's
 * error never tears down a list the caller already has.
 *
 * `isDataEmpty` and `isResultEmpty` are deliberately separate: the error
 * branch must key off the raw fetch result (`isDataEmpty`) so a background
 * refresh failure on a drive with cached sessions never reads as "failed to
 * load" just because the current search happens to match nothing — that case
 * belongs to the plain empty-result branch (`isResultEmpty`) instead.
 */
export function resolveListNotice({
  authLoading,
  isAdmin,
  hasError,
  isLoading,
  isDataEmpty,
  isResultEmpty,
  emptyTitle,
  onRetry,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  hasError: boolean;
  isLoading: boolean;
  isDataEmpty: boolean;
  isResultEmpty: boolean;
  emptyTitle: string;
  onRetry: () => void;
}): React.ReactNode {
  if (authLoading) return <SidebarLoading message="Loading…" />;
  if (!isAdmin) return <SidebarNotice title="Agent sandboxes require administrator privileges" />;
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
  isAdmin,
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
  isAdmin: boolean;
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

  const canSpawn = isAdmin && !authLoading;

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
    isAdmin,
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
  // first — see session-groups.ts for the ordering rule); a single implicit
  // group in drive mode, always present (even with zero sessions) so its
  // header — and the header's spawn affordance — never disappears mid-load.
  const groups = useMemo(() => {
    if (driveId) return [{ driveId, driveName: null, sessions: filteredSessions }];
    return buildSessionGroups(filteredSessions, { assistant: canSpawn, drives: roster });
  }, [driveId, filteredSessions, canSpawn, roster]);

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
          {!driveId && (
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
            <SessionRow key={session.sessionId} session={session} agentNamesById={agentNamesById} />
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

/** One session: name + running dot, expanding to its conversations (never its panes). */
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
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const forgetWorkspace = useAgentWorkspaceStore((state) => state.forgetWorkspace);
  const hydrateWorkspace = useAgentWorkspaceStore((state) => state.hydrateWorkspace);
  const resetPane = useAgentWorkspaceStore((state) => state.resetPane);
  const assignPane = useAgentWorkspaceStore((state) => state.assignPane);
  const [expanded, setExpanded] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const isSelected = selectedSessionId === session.sessionId;
  const isRunning = session.sandboxStatus === 'running' || session.sandboxStatus === 'starting';

  const openConversation = useCallback(
    (conversation: SessionConversationEntry) => {
      selectConversation({
        sessionId: session.sessionId,
        conversationId: conversation.conversationId,
        agentId: conversation.agentPageId,
      });
    },
    [selectConversation, session.sessionId],
  );

  /**
   * A pane (or one of its tabs) addresses a conversation by id/agent alone —
   * resolve it against the session's own conversation listing for a real
   * title when one is open, so a pane/tab row's label matches
   * `conversationLabel`'s exactly. `title` plays no role in `openConversation`
   * itself (only `conversationId`/`agentPageId` do); this is purely for display.
   */
  const conversationEntryForTarget = useCallback(
    (targetId: string, agentPageId: string | null): SessionConversationEntry =>
      session.conversations.find((c) => c.conversationId === targetId) ?? {
        conversationId: targetId,
        title: null,
        agentPageId,
      },
    [session.conversations],
  );

  const openShell = useCallback(
    (shell: { shellId: string; name: string }) => {
      selectSession(session.sessionId);
      // `session.conversations` is this row's own already-resolved live
      // listing (the row couldn't exist here otherwise) — protects a chat
      // pane showing a conversation closed out of the session from being
      // silently evicted by an unrelated shell reattach (issue #2295).
      useAgentWorkspaceStore.getState().openConversation(
        session.sessionId,
        {
          kind: 'terminal',
          name: shell.name,
          targetId: shell.shellId,
          agentPageId: null,
        },
        { liveConversationIds: new Set(session.conversations.map((c) => c.conversationId)) },
      );
    },
    [selectSession, session.sessionId, session.conversations],
  );

  const openSession = useCallback(() => {
    // Selecting a SESSION opens its most recent conversation — the row is a
    // workspace, and a workspace opens on its work, not on a placeholder.
    // With a saved grid, that's the ACTIVE pane's own active tab (falling
    // back to its first chat pane if the active one isn't a chat at all —
    // a terminal, say). A shell-first session has no conversations at all,
    // so fall back to its first shell rather than leave the click a no-op.
    setExpanded(true);
    if (session.workspace) {
      const panes = panesOf(session.workspace);
      const activePane = panes.find((p) => p.id === session.workspace!.activePaneId);
      const chatPane =
        (activePane?.scope?.kind === 'chat' && activePane.scope.targetId ? activePane : undefined) ??
        panes.find((p) => p.scope?.kind === 'chat' && p.scope.targetId !== null);
      if (chatPane?.scope?.kind === 'chat' && chatPane.scope.targetId) {
        openConversation(conversationEntryForTarget(chatPane.scope.targetId, chatPane.scope.agentPageId));
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
  }, [openConversation, openShell, conversationEntryForTarget, session.workspace, session.conversations, session.shells]);

  const endSession = useCallback(async () => {
    // Snapshot for rollback, then assume success immediately — the row must
    // not linger in the sidebar for however long the sandbox-kill round trip
    // this DELETE triggers server-side actually takes.
    const workspaceSnapshot = useAgentWorkspaceStore.getState().workspaces[session.sessionId] ?? null;
    const wasSelected = selectedSessionId === session.sessionId;
    setEnding(true);
    // The session leaves the sidebar; its conversations remain as history in
    // each agent's list. Drop the local grid too — its panes pointed at a
    // sandbox that no longer exists.
    forgetWorkspace(session.sessionId);
    if (wasSelected) selectSession(null);
    setConfirmingEnd(false);
    forgetSessionInCache(mutate, session.sessionId);
    try {
      await del(`/api/agent-sessions/${encodeURIComponent(session.sessionId)}`);
    } catch (error) {
      // The optimistic assumption was wrong — restore the grid and selection,
      // and let a real revalidate (not a stale local patch) put the row back.
      if (workspaceSnapshot) hydrateWorkspace(session.sessionId, workspaceSnapshot);
      if (wasSelected) selectSession(session.sessionId);
      void mutate(isAgentSessionsKey);
      console.error('Failed to end session:', error);
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      return;
    } finally {
      setEnding(false);
    }
    // Confirmed — background reconcile only; the grid and sidebar are already right.
    void mutate(isAgentSessionsKey);
  }, [forgetWorkspace, hydrateWorkspace, mutate, selectSession, selectedSessionId, session.sessionId]);

  const closeConversation = useCallback(
    async (conversationId: string) => {
      try {
        await del(
          `/api/agent-sessions/${encodeURIComponent(session.sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          // The session's LAST open listing — the server is the authority on
          // the never-empty invariant; fall back to the same confirmed
          // end-session flow the row's own "End session" already uses
          // (mirrors the pane grid's identical 409 fallback in AgentPanes).
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
      // network round trip on top of the DELETE that just resolved. A
      // background reconcile still follows, same as every other mutating
      // action here — it just no longer gates what the user sees.
      forgetConversationInCache(mutate, session.sessionId, conversationId);
      void mutate(isAgentSessionsKey);
    },
    [mutate, session.sessionId],
  );

  // Closing a pane's own conversation from the sidebar — a real DELETE
  // (session-scoped listing), unless another pane in this same grid is ALSO
  // showing it, in which case there is nothing server-side to do; either
  // way this pane itself unbinds back to the picker (`resetPane`), the same
  // recovery a History delete or a failed mint already uses.
  const closePaneConversation = useCallback(
    async (paneId: string, conversationId: string) => {
      // Read the LIVE grid, not the `session.workspace` prop — that's an SWR
      // snapshot (polled every 20s), so a second pane opened on this same
      // conversation moments ago could be invisible to it (review finding,
      // carried over from this row's own tab-era close control).
      const liveWorkspace = useAgentWorkspaceStore.getState().workspaces[session.sessionId];
      const shownElsewhere = liveWorkspace
        ? panesOf(liveWorkspace).some(
            (p) => p.id !== paneId && p.scope?.kind === 'chat' && p.scope.targetId === conversationId,
          )
        : false;
      if (shownElsewhere) {
        resetPane(session.sessionId, paneId);
        return;
      }
      try {
        await del(
          `/api/agent-sessions/${encodeURIComponent(session.sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
        // The grid never empties (contract invariant 3): if this was the
        // grid's ONLY pane, prefer rebinding it to another open listing over
        // leaving it on an empty picker — the same grid-last rebind
        // `decideClosePane` gives the pane grid's own close control (review
        // finding — chatgpt-codex-connector on PR #2308). Read the LIVE grid
        // again (not the snapshot above) — the DELETE's own round trip is
        // exactly the window a concurrent split/close could land in.
        const liveWorkspaceNow = useAgentWorkspaceStore.getState().workspaces[session.sessionId];
        const rebindTarget =
          liveWorkspaceNow && isLastPane(liveWorkspaceNow, paneId)
            ? session.conversations.find((c) => c.conversationId !== conversationId)
            : undefined;
        if (rebindTarget) {
          assignPane(session.sessionId, paneId, {
            kind: 'chat',
            name: 'Conversation',
            targetId: rebindTarget.conversationId,
            agentPageId: rebindTarget.agentPageId,
          });
        } else {
          resetPane(session.sessionId, paneId);
        }
        // Instant sidebar freshness — a local cache patch instead of a full
        // revalidate, so the row leaves the listing without a second,
        // sequential network round trip on top of the DELETE that just
        // resolved. A background reconcile still follows, same as every
        // other mutating action here — it just no longer gates what the
        // user sees.
        forgetConversationInCache(mutate, session.sessionId, conversationId);
        void mutate(isAgentSessionsKey);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          setConfirmingEnd(true);
          return;
        }
        console.error('Failed to close this conversation:', error);
        toast.error('Could not close this conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      }
    },
    [mutate, session.sessionId, session.conversations, resetPane, assignPane],
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

  // Only chat panes address a conversation — a terminal/page/still-unbound
  // pane has nothing to show here (shells get their own section below,
  // unchanged). `null` when this session has no saved grid yet, so the
  // render falls back to the flat `session.conversations` list.
  const chatPanes = useMemo(
    () =>
      session.workspace
        ? panesOf(session.workspace).filter(
            (pane): pane is PaneState & { scope: { kind: 'chat'; targetId: string } } =>
              pane.scope?.kind === 'chat' && pane.scope.targetId !== null,
          )
        : null,
    [session.workspace],
  );

  return (
    <div>
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
            // plain `<span aria-label>` is not announced by most screen
            // readers, since aria-label is only honoured on elements with a
            // role that supports naming.
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
        isEnding={ending}
        onConfirm={() => void endSession()}
      />

      {expanded && (
        <div className="ml-4 space-y-0.5 border-l border-border pl-1.5">
          {chatPanes
            ? chatPanes.map((pane) => (
                <PaneRow
                  key={pane.id}
                  pane={pane}
                  conversationEntryForTarget={conversationEntryForTarget}
                  conversationLabel={conversationLabel}
                  selectedConversationId={selectedConversationId}
                  onOpenConversation={openConversation}
                  onClose={closePaneConversation}
                />
              ))
            : session.conversations.map((conversation) => (
                <RowMenu
                  key={conversation.conversationId}
                  items={[
                    {
                      label: 'Close',
                      icon: X,
                      onSelect: () => void closeConversation(conversation.conversationId),
                      destructive: true,
                    },
                  ]}
                  menuLabel="Conversation actions"
                  className={cn(
                    'gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
                    selectedConversationId === conversation.conversationId && 'bg-accent text-foreground',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center text-left"
                    onClick={() => openConversation(conversation)}
                  >
                    <span className="truncate">{conversationLabel(conversation)}</span>
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
          {(chatPanes ?? session.conversations).length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No conversations</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One PANE's row: labeled by its own conversation, updating in place on an
 * agent switch instead of a sibling row appearing — the fix for "changing
 * the agent in a pane spawns a new sidebar item."
 */
function PaneRow({
  pane,
  conversationEntryForTarget,
  conversationLabel,
  selectedConversationId,
  onOpenConversation,
  onClose,
}: {
  pane: PaneState & { scope: { kind: 'chat'; targetId: string; agentPageId: string | null } };
  conversationEntryForTarget: (targetId: string, agentPageId: string | null) => SessionConversationEntry;
  conversationLabel: (conversation: SessionConversationEntry) => string;
  selectedConversationId: string | null;
  onOpenConversation: (conversation: SessionConversationEntry) => void;
  onClose: (paneId: string, conversationId: string) => void | Promise<void>;
}) {
  const activeEntry = conversationEntryForTarget(pane.scope.targetId, pane.scope.agentPageId);

  return (
    <RowMenu
      items={[
        {
          label: 'Close',
          icon: X,
          onSelect: () => void onClose(pane.id, pane.scope.targetId),
          destructive: true,
        },
      ]}
      menuLabel="Conversation actions"
      className={cn(
        'gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
        selectedConversationId === pane.scope.targetId && 'bg-accent text-foreground',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center text-left"
        onClick={() => onOpenConversation(activeEntry)}
      >
        <span className="truncate">{conversationLabel(activeEntry)}</span>
      </button>
    </RowMenu>
  );
}

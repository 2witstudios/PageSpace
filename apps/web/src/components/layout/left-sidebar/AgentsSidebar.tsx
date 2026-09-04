'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { useSWRConfig } from 'swr';

import EndSessionDialog from '@/components/agents/EndSessionDialog';
import { useSpawnSession } from '@/components/agents/useSpawnSession';
import DrivePickerDialog from '@/components/agents/DrivePickerDialog';
import { Input } from '@/components/ui/input';
import { cn, isElectron } from '@/lib/utils';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
import CreateDriveDialog from './CreateDriveDialog';
import DashboardFooter from './DashboardFooter';
import DriveFooter from './DriveFooter';
import PrimaryNavigation from './PrimaryNavigation';
import { SidebarLoading, SidebarNotice } from './sidebar-states';
import { matchesKeyEvent, getEffectiveBinding } from '@/stores/useHotkeyStore';
import { isEditingActive } from '@/stores/useEditingStore';
import { useAuth } from '@/hooks/useAuth';
import { useTouchDevice } from '@/hooks/useTouchDevice';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useDriveStore, type Drive } from '@/hooks/useDrive';
import { canManageDrive, isDriveOwner } from '@/hooks/usePermissions';
import { usePageAgents, type DriveWithAgents } from '@/hooks/page-agents/usePageAgents';
import { useAgentSurfaceStore, SHEET_BREAKPOINT_QUERY } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import {
  artifactRowsOf,
  conversationPlacement,
  gridPanesOf,
  indexTargets,
  lookupTarget,
  paneNodesOf,
  type MemberPlacement,
} from '@/stores/agent-workspace/workspace-tree-view';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceNodeTarget } from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { fetchWithAuth, del, patch, post, ApiRequestError } from '@/lib/auth/auth-fetch';
import {
  isAgentWorkspacesKey,
  isWorkspaceListingKey,
  forgetWorkspaceInCache,
  forgetConversationInCache,
  restoreWorkspaceInCache,
} from '@/components/agents/panes/workspace-conversations';
import { decideClosePane } from '@/components/agents/panes/close-pane';
import { buildSessionGroups, ASSISTANT_GROUP_KEY } from './session-groups';
import { partitionSessionsByEnv, type EnvGroup } from './env-groups';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { DeleteDriveEnvDialog, DriveEnvNameDialog, RebuildDriveEnvDialog } from './DriveEnvDialogs';
import { DriveEnvAppPane } from './DriveEnvAppPane';
import { useDriveEnvs } from '@/hooks/drive-envs/useDriveEnvs';
import { reportDriveEnvWriteFailure, type DriveEnvWriteOutcome } from '@/hooks/drive-envs/drive-env-writes';
import type { DriveEnvStatus } from '@pagespace/lib/drive-envs/env-contract';

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
 *  - Every member is visible, and now that is a property of the model rather
 *    than of this component's diligence. There is one place a node can be, so
 *    walking the tree IS enumerating the members: there is no second list to
 *    remember and no dimmed "in the workspace, not on your screen" state to
 *    render. #2373 — one production workspace showing 2 of its 3 threads,
 *    another 4 of its 10 — cannot recur, because a thread that is in a
 *    workspace is in its tree.
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
  /**
   * The persistent ENVIRONMENT this session runs inside, or null for the
   * ordinary ephemeral one. It is what the sidebar nests by: two sessions
   * carrying the same value are two windows onto one filesystem, so grouping by
   * it groups by the disk rather than by a label (see the field's docblock on
   * `session-contract.ts`). It also changes what `sandboxStatus` below reads —
   * for an env-bound session that status is the ENVIRONMENT's machine, shared
   * with every other session in it.
   */
  envId: string | null;
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

  // Which drives this user may ADMINISTER — environment CRUD is drive
  // OWNER/ADMIN, so the affordances that need it are not rendered at all for a
  // plain member rather than rendered and refused. Same source and same helper
  // the drive footer's manage controls use; a drive the roster does not hold
  // (an orphan group) is simply absent from the set, which reads as "no".
  const manageableDriveIds = useMemo(
    () => new Set(drives.filter((d) => canManageDrive(d)).map((d) => d.id)),
    [drives],
  );

  // Which drives this user OWNS — stricter than manageableDriveIds. Spending
  // the drive's money (the dedicated-hosting purchase surface) is gated on
  // this, not on ADMIN/OWNER manage rights: an admin may run an app, not buy
  // hosting on the owner's card.
  const ownerDriveIds = useMemo(
    () => new Set(drives.filter((d) => isDriveOwner(d)).map((d) => d.id)),
    [drives],
  );

  const [createDriveOpen, setCreateDriveOpen] = useState(false);
  const { openSpawn, openSpawnInEnv, openAssistantSpawn, paletteElement } = useSpawnSession(agentsByDrive, onChanged);

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

  // Whether the drive this surface is scoped to can be given new work at all.
  // A trashed drive is on its way out: the group-header path has always
  // withheld its spawn "+" for that reason, and everything below routes
  // through this one answer so the drive-scoped header, the hotkey and the
  // palette's environment entry cannot disagree about it.
  const isLiveScopedDrive = driveId !== undefined && !trashedDriveIds.has(driveId);

  // Global mode's own "where" question: with no drive in the route there is
  // nothing to spawn INTO, so the flow starts by picking one — the same
  // `DrivePickerDialog` step `AgentsListHeader` takes, including the Global
  // Assistant, which is a valid destination for a session and for nothing else.
  const [sessionDrivePickerOpen, setSessionDrivePickerOpen] = useState(false);

  const startNewSession = useCallback(() => {
    if (driveId) {
      // A trashed drive gets nothing new — not a session, and not the drive
      // dialog either, which would answer a question nobody asked.
      if (!isLiveScopedDrive) return;
      handleNewSession(driveId, null);
      return;
    }
    setSessionDrivePickerOpen(true);
  }, [driveId, isLiveScopedDrive, handleNewSession]);

  // THE QUICK-CREATE HOTKEY, ON THE AGENTS ROUTES, MEANS THIS SURFACE'S "NEW".
  //
  // Elsewhere it opens the page-type palette; here "new" is a session — or the
  // environment to run one in, which the spawn palette now offers too — so the
  // binding opens the spawn flow, and `QuickCreatePalette` stands down while
  // this route is active. That holds on the GLOBAL console too: it has no
  // drive of its own, so it asks for one and carries on into the same palette,
  // rather than diverting to drive creation, which is a different act that
  // never reaches an environment or a session.
  //
  // Registered HERE, not in `AgentsListHeader`, because the header only renders
  // in the list/empty state (it is gone inside an open session) while this
  // sidebar is mounted on every Agents route. The header keeps its own
  // `useSpawnSession` and registers no hotkey, so exactly one handler fires.
  useEffect(() => {
    if (!canSpawn) return;
    const handler = (event: KeyboardEvent) => {
      if (!matchesKeyEvent(getEffectiveBinding('pages.quick-create'), event)) return;
      if (isEditingActive()) return;
      event.preventDefault();
      startNewSession();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [canSpawn, startNewSession]);

  return (
    <div className="space-y-1">
      {canSpawn && (
        <SessionSearchHeader
          value={searchQuery}
          onChange={setSearchQuery}
          // A trashed drive is offered nothing new — the same withholding the
          // group headers have always done one level down, applied here where
          // the drive IS the whole surface. Global mode keeps "New drive": it
          // is the only place that offers one, and the hotkey's session flow
          // (which asks for a drive first) does not replace it.
          onAction={
            driveId
              ? isLiveScopedDrive
                ? () => handleNewSession(driveId, null)
                : undefined
              : () => setCreateDriveOpen(true)
          }
          actionLabel={driveId ? 'New session' : 'New drive'}
        />
      )}
      {visibleGroups.map((group) => {
        // Environments belong to a real, live drive. The Assistant group is not
        // one (it is the drive-less bucket) and a trashed drive must not be
        // offered infrastructure it is on its way out of — both fall back to a
        // flat list of sessions, which is what they had before.
        const isLiveDrive = group.driveId !== ASSISTANT_GROUP_KEY && !trashedDriveIds.has(group.driveId);
        return (
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
          <DriveGroupRows
            driveId={group.driveId}
            sessions={group.sessions}
            agentNamesById={agentNamesById}
            canManage={manageableDriveIds.has(group.driveId)}
            isOwner={ownerDriveIds.has(group.driveId)}
            // Three things switch it off. `canSpawn` is the authentication gate
            // — the same one that nulls the sessions SWR key, because a surface
            // that will not show a signed-out visitor anything has no business
            // fetching a drive's infrastructure on their behalf. Search is a
            // FLAT find over session names (the header says so), and an
            // environment whose sessions were all filtered out would otherwise
            // sit there as an empty container claiming to be a match — so while
            // a query is active every matching session renders at drive level
            // and the environment rows step aside.
            showEnvironments={canSpawn && isLiveDrive && !hasSearch}
            onNewSessionInEnv={(envId) => openSpawnInEnv(group.driveId, group.driveName, envId)}
          />
        </div>
        );
      })}
      {notice}
      {paletteElement}
      <DrivePickerDialog
        open={sessionDrivePickerOpen}
        onOpenChange={setSessionDrivePickerOpen}
        onPick={(pickedDriveId, pickedDriveName) => {
          setSessionDrivePickerOpen(false);
          openSpawn(pickedDriveId, pickedDriveName);
        }}
        onPickGlobalAssistant={() => {
          setSessionDrivePickerOpen(false);
          openAssistantSpawn();
        }}
      />
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
  /** Omitted when there is nothing to create — a trashed drive gets no "+". */
  onAction?: () => void;
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
      {onAction && (
        <button
          type="button"
          aria-label={actionLabel}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onAction}
        >
          <Plus className="size-3.5" />
        </button>
      )}
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
      <span className="flex shrink-0 items-center gap-1">
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
      </span>
    </div>
  );
}

/**
 * One drive group's contents: its ENVIRONMENTS, then its loose sessions.
 *
 * The two are siblings on purpose. A drive contains environments AND sessions
 * at the same level — an environment is not a folder someone filed sessions
 * into, it is a machine the drive owns, and a session either runs inside one or
 * owns its own sandbox. Nesting a session under its environment is therefore
 * showing which filesystem it sees, not organising a list.
 *
 * The environments fetch lives HERE, one hook per rendered drive group, rather
 * than as one bulk read in the parent: a group is where a drive id first exists
 * as a single value, the listing is small and cached per drive, and the spawn
 * palette shares the key so opening it costs nothing extra.
 */
function DriveGroupRows({
  driveId,
  sessions,
  agentNamesById,
  canManage,
  isOwner,
  showEnvironments,
  onNewSessionInEnv,
}: {
  driveId: string;
  sessions: SessionListEntry[];
  agentNamesById: Map<string, string>;
  canManage: boolean;
  /** May spend this drive's money — stricter than `canManage`. See `DriveEnvAppPane`'s dedicated-tier gate. */
  isOwner: boolean;
  showEnvironments: boolean;
  /** Start a session INSIDE one of this drive's environments — the row's own "+". */
  onNewSessionInEnv: (envId: string) => void;
}) {
  const { envs, error: envsError, mutate: refreshEnvs } = useDriveEnvs(driveId, { enabled: showEnvironments });

  // With environments off (the Assistant bucket, a trashed drive, an active
  // search) this hands back every session as loose, which is exactly the flat
  // list this surface rendered before environments existed.
  const { envGroups, looseSessions } = useMemo(
    () => (showEnvironments ? partitionSessionsByEnv(sessions, envs) : { envGroups: [], looseSessions: sessions }),
    [showEnvironments, sessions, envs],
  );

  return (
    <>
      {/* A FAILED LISTING SAYS SO. Without this the drive reads as one that
          simply has no environments, and any env-bound session in it falls
          through to an orphan group — a correct mechanism reached for the wrong
          reason, and one the user cannot act on because nothing told them a
          read failed. The retry is the affordance; the sessions below still
          render, because a drive's sessions do not depend on this request. */}
      {showEnvironments && envsError != null && (
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span className="truncate">Could not load environments</span>
          <button
            type="button"
            /* "Try again", not "Retry": the sidebar already has a Retry for the
               SESSIONS listing, and when both requests fail the two sit feet
               apart. Distinct words are the difference between one control and
               two identical ones the user has to guess between. */
            aria-label="Try again loading environments"
            className="shrink-0 underline hover:text-foreground"
            onClick={refreshEnvs}
          >
            Try again
          </button>
        </div>
      )}
      {envGroups.map((group) => (
        <DriveEnvRow
          key={group.envId}
          driveId={driveId}
          group={group}
          canManage={canManage}
          isOwner={isOwner}
          agentNamesById={agentNamesById}
          onEnvsChanged={refreshEnvs}
          onNewSession={() => onNewSessionInEnv(group.envId)}
        />
      ))}
      {looseSessions.map((session) => (
        <SessionRow key={session.workspaceId} session={session} agentNamesById={agentNamesById} />
      ))}
    </>
  );
}

/**
 * An environment's status, as a dot — the only badge an environment row carries.
 *
 * Always rendered, unlike a session's dot, and that difference is the point. A
 * session's dot appears when it has a sandbox and is absent otherwise, because
 * a session without one is just a conversation. An environment without a
 * machine is still an environment: it is drive infrastructure that exists,
 * costs its keep, and provisions on first use. A dot that disappeared would say
 * the environment had, so `'none'` gets a dimmed dot and a name for the state
 * rather than nothing at all.
 */
function EnvStatusDot({ status }: { status: DriveEnvStatus | null }) {
  const { className, label } =
    status === 'running'
      ? { className: 'bg-emerald-500', label: 'Environment running' }
      : status === 'stopped'
        ? { className: 'bg-amber-500', label: 'Environment stopped' }
        : status === 'none'
          ? { className: 'bg-muted-foreground/40', label: 'Environment not started yet' }
          : { className: 'bg-muted-foreground/40', label: 'Environment status unknown' };
  // `role="img"` so the label is announced — aria-label on a bare span is not.
  return <span role="img" aria-label={label} className={cn('size-1.5 shrink-0 rounded-full', className)} />;
}

/**
 * ONE ENVIRONMENT: name, status dot, and the sessions running inside it.
 *
 * It renders **even with no sessions**, and that is deliberate rather than an
 * oversight about empty states. An environment is infrastructure someone
 * created on purpose and is billed for; a row that vanished whenever nobody
 * happened to be working would recreate exactly the ephemeral mental model
 * environments exist to replace.
 *
 * Management is drive OWNER/ADMIN, so a member gets a row with no menu at all
 * rather than a menu that refuses — the same way the group header withholds its
 * "New environment" button. An ORPHAN (a session naming an environment this
 * drive's listing did not return) also gets no menu: there is no row here to
 * act on, and offering to rename or destroy something we cannot see would be
 * guessing.
 */
function DriveEnvRow({
  driveId,
  group,
  canManage,
  isOwner,
  agentNamesById,
  onEnvsChanged,
  onNewSession,
}: {
  driveId: string;
  group: EnvGroup<SessionListEntry>;
  canManage: boolean;
  isOwner: boolean;
  agentNamesById: Map<string, string>;
  onEnvsChanged: () => void;
  onNewSession: () => void;
}) {
  const { mutate } = useSWRConfig();
  const isTouchDevice = useTouchDevice();
  // Expanded by default: an environment's whole claim is that it is a place you
  // come back to, and its sessions are the reason to look at it.
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const isOrphan = group.envName === null;
  // An orphan has no name to show and its id is not one: a raw CUID is not a
  // thing a user has ever seen or could recognise, and printing it would read
  // as the environment's name rather than as the absence of one. What we
  // actually know is that a session claims an environment this drive's listing
  // did not return — so say that, and keep the id out of the interface.
  const displayName = group.envName ?? 'Unavailable environment';
  const envPath = `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(group.envId)}`;

  const renameEnv = useCallback(
    async (name: string): Promise<DriveEnvWriteOutcome> => {
      try {
        await patch(envPath, { name });
      } catch (error) {
        return reportDriveEnvWriteFailure(error, 'Could not rename the environment');
      }
      onEnvsChanged();
      return 'done';
    },
    [envPath, onEnvsChanged],
  );

  const deleteEnv = useCallback(
    async ({ force }: { force: boolean }): Promise<{ blockedByLiveSessions: number } | null> => {
      try {
        await del(force ? `${envPath}?force=true` : envPath);
      } catch (error) {
        // The ONE refusal that is not an ending: sessions are still live inside
        // the environment, and the dialog escalates to the forced delete rather
        // than closing. `liveSessionCount` is the server's — this listing only
        // holds the viewer's own sessions, so a teammate's is invisible here.
        if (error instanceof ApiRequestError && error.status === 409) {
          const body = error.body as { reason?: unknown; liveSessionCount?: unknown } | null;
          if (body?.reason === 'live_sessions') {
            return { blockedByLiveSessions: typeof body.liveSessionCount === 'number' ? body.liveSessionCount : 0 };
          }
        }
        toast.error('Could not delete the environment', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        return null;
      }
      onEnvsChanged();
      // Deleting an environment CASCADES its sessions away, so the sessions
      // listing is stale the moment this resolves — not just the env listing.
      void mutate(isWorkspaceListingKey);
      toast.success(`Deleted “${displayName}”`);
      return null;
    },
    [envPath, onEnvsChanged, mutate, displayName],
  );

  const rebuildEnv = useCallback(async () => {
    try {
      await post(`${envPath}/rebuild`);
    } catch (error) {
      toast.error('Could not rebuild the environment', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      return;
    }
    onEnvsChanged();
    // The sessions listing goes stale too, for the same reason the delete path
    // refreshes it: an env-bound session's `sandboxStatus` is read off the
    // ENVIRONMENT's row, not its own, so replacing the environment's machine
    // changes what every session inside it should be rendering. Without this
    // the rows keep claiming `running` against a machine that no longer exists.
    void mutate(isWorkspaceListingKey);
    toast.success(`“${displayName}” was rebuilt`, { description: 'It came back blank.' });
  }, [envPath, onEnvsChanged, mutate, displayName]);

  const menuItems: RowMenuItem[] = useMemo(
    () => [
      { label: 'Rename', icon: Pencil, onSelect: () => setRenaming(true) },
      { label: 'Rebuild to blank', icon: RefreshCw, onSelect: () => setRebuilding(true), destructive: true },
      { label: 'Delete environment', icon: Trash2, onSelect: () => setDeleting(true), destructive: true },
    ],
    [],
  );

  const rowInner = (
    <>
      <button
        type="button"
        aria-label={expanded ? `Collapse ${displayName}` : `Expand ${displayName}`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Boxes className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <EnvStatusDot status={group.status} />
        <span className="truncate font-medium text-foreground">{displayName}</span>
      </span>
      {/* Every other level of this tree offers one; the level that IS a place to
          come back to was the only one that did not. Not gated on `canManage`:
          binding a session to an environment is member-level server-side, and
          management (rename/rebuild/delete) is the OWNER/ADMIN act — this is
          not. Withheld from an ORPHAN, which names an environment this drive's
          listing did not return: there is nothing here to spawn into. */}
      {!isOrphan && (
        <button
          type="button"
          aria-label={`New session in ${displayName}`}
          title={`New session in ${displayName}`}
          // Revealed exactly the way this row's menu trigger is — hover on a
          // pointer, always on a touch device, where there is no hover to
          // reveal it with.
          className={cn(
            'shrink-0 text-muted-foreground transition-opacity hover:text-foreground',
            isTouchDevice ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
          onClick={(event) => {
            // The row's own click targets (its context menu, its disclosure)
            // must not also fire.
            event.stopPropagation();
            onNewSession();
          }}
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </>
  );

  const rowClassName = 'gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent';

  return (
    <div data-testid={`sidebar-env-${group.envId}`}>
      {canManage && !isOrphan ? (
        <RowMenu items={menuItems} menuLabel="Environment actions" className={rowClassName}>
          {rowInner}
        </RowMenu>
      ) : (
        <div className={cn('group flex w-full items-center', rowClassName)}>{rowInner}</div>
      )}

      <DriveEnvNameDialog
        open={renaming}
        onOpenChange={setRenaming}
        initialName={group.envName ?? ''}
        onSubmit={renameEnv}
      />
      <DeleteDriveEnvDialog
        open={deleting}
        onOpenChange={setDeleting}
        envName={displayName}
        onDelete={deleteEnv}
      />
      <RebuildDriveEnvDialog
        open={rebuilding}
        onOpenChange={setRebuilding}
        envName={displayName}
        onRebuild={rebuildEnv}
      />

      {expanded && (
        <div className="ml-4 space-y-0.5 border-l border-border pl-1.5">
          {group.sessions.map((session) => (
            <SessionRow key={session.workspaceId} session={session} agentNamesById={agentNamesById} />
          ))}
          {group.sessions.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No sessions running in here</div>
          )}
        </div>
      )}
      {!isOrphan && (
        <DriveEnvAppPane
          driveId={driveId}
          envId={group.envId}
          envName={displayName}
          canManage={canManage}
          isOwner={isOwner}
        />
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
   * THE PAGE ARTIFACTS THIS WORKSPACE HOLDS.
   *
   * One walk over one tree. This used to concatenate a second list — the parked
   * panes — because a member could be in the workspace and nowhere in it, which
   * was the #2373 fork rebuilt inside the model that was supposed to have
   * deleted it. `artifactRowsOf` walks the flat list, and the flat list is all
   * of it.
   */
  const artifactRows = useMemo(() => (tree ? artifactRowsOf(tree) : []), [tree]);

  /**
   * Every thread in this workspace, each annotated with where its node sits.
   *
   * The THREAD is the row and the node is an attribute of it — a thread this
   * workspace does not hold has no node here at all, so this list is keyed
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
        // No 409 branch: the server stopped refusing the last close in the
        // node-tree cutover, so the `last_conversation` fallback that used to
        // live here was dead code. The last-pane end-session it reached for is
        // decided on the client now, by `decideClosePane` — see
        // `closeConversationRow` below.
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
   * With a node here, Close destroys that node, which is what taking the thread
   * out of this workspace IS. Without one, the workspace does not hold it and
   * the close goes to the listing route, which answers the same way.
   *
   * The old version had to seat a snapshot first (`ensureLocalWorkspace`), because
   * a row could act on a workspace whose grid was never mounted and a raw store
   * read came back undefined — at which point "close this pane" silently became
   * "DELETE this conversation". Every listed workspace is seated now, on every
   * revalidation, so there is no such gap; and if `tree` is somehow absent the
   * placement reads `unplaced`, which closes the LISTING rather than guessing.
   */
  /**
   * Destroy one of this workspace's nodes from a sidebar row — through the SAME
   * decision the pane's own close button takes.
   *
   * It used to call `closePane` directly, which meant the sidebar could empty a
   * workspace's tree in a way the grid refuses to: two affordances for one act,
   * disagreeing about the last one. `decideClosePane` is that act, so both go
   * through it and the last row raises the confirm this row already owns.
   *
   * `canEndSession: true` is a fact about THIS listing, not an assumption. It
   * is filtered `{ownerId: auth.userId}` (`GET /api/agent-workspaces`), so every
   * session here is the viewer's own, and `decideAgentSessionEndAccess` allows
   * the owner unconditionally — release-of-compute needs no capability. The
   * pane grid, which can be mounted on someone else's workspace, resolves the
   * real answer from the session record instead.
   */
  const closeNodeRow = useCallback(
    (nodeId: string) => {
      const decision = decideClosePane({
        panes: tree ? paneNodesOf(tree.nodes) : [],
        nodeId,
        // This row's own listing — the same fact the grid feeds the decision,
        // from the poll that produced the row.
        activeConversations: session.conversations,
        canEndSession: true,
      });
      if (decision.action === 'end-session') {
        setConfirmingEnd(true);
        return;
      }
      if (decision.action === 'noop') return;
      closePane(session.workspaceId, nodeId);
    },
    [closePane, session.workspaceId, session.conversations, tree],
  );

  const closeConversationRow = useCallback(
    (conversationId: string, placement: MemberPlacement, nodeId: string | null) => {
      if (placement === 'grid' && nodeId !== null) {
        closeNodeRow(nodeId);
        return;
      }
      void closeConversation(conversationId);
    },
    [closeNodeRow, closeConversation],
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
    (nodeId: string) => {
      selectSession(session.workspaceId);
      // Every row here names a node that is IN the tree, so clicking one is
      // focus and nothing else. It used to branch: a PARKED node had to be moved
      // back onto the grid first, and that branch was a parked row's only
      // affordance. There are no parked rows.
      showNode(session.workspaceId, nodeId);
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
        className={cn('gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent', isSelected && 'bg-primary-soft')}
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
                  // One label, because there is one thing the row can be: open.
                  // It used to read "Show" for a parked row, which was the
                  // affordance for a member that was not on screen.
                  label: 'Close',
                  icon: X,
                  onSelect: () => (row.nodeId === null ? undefined : closeNodeRow(row.nodeId)),
                  destructive: true,
                },
              ]}
              menuLabel="Page pane actions"
              className="gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => (row.nodeId === null ? undefined : openArtifact(row.nodeId))}
                title={row.title}
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
 * the click performs are the same decision. There are two states rather than
 * three: this workspace holds a node for the thread, or it does not. The third
 * — `parked`, a member off the screen, rendered dimmed — is gone with the state
 * it described.
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
          // Same act either way — the thread leaves this workspace — but the
          // label names what the click actually addresses, which is the node
          // when there is one and the listing when there is not.
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
        isSelected && 'bg-primary-soft text-foreground',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center text-left"
        onClick={onOpen}
        title={placement === 'grid' ? label : `${label} (not in this session)`}
      >
        <span className="truncate">{label}</span>
      </button>
    </RowMenu>
  );
}

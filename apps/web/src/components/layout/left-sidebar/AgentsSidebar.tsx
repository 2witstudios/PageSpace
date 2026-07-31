'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Bot, ChevronDown, ChevronRight, MessageSquarePlus, Plus, SquareTerminal, X } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';

import EndSessionDialog from '@/components/agents/EndSessionDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn, isElectron } from '@/lib/utils';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
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
import { fetchWithAuth, post, del, ApiRequestError } from '@/lib/auth/auth-fetch';
import { buildSessionGroups, ASSISTANT_GROUP_KEY } from './session-groups';
import { RowMenu, type RowMenuItem } from './RowMenu';

/**
 * The Agents console's left sidebar: **Drive → Session → conversations.**
 *
 * A SESSION is the tree's second level — a drive-level workspace that owns one
 * sandbox and hosts conversations (with any of the drive's agents) plus shells.
 * Agents are NOT a tree level: they are what you pick when spawning a session
 * or a pane. And PANES are never listed here — layout is centre-view state
 * (the old sidebar's `WorkspaceLeaves` pattern is deliberately not restored).
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

        <ScrollArea className="flex-1 min-h-0">
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
        </ScrollArea>

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
}

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
 */
function resolveListNotice({
  authLoading,
  isAdmin,
  hasError,
  isLoading,
  isEmpty,
  emptyTitle,
  onRetry,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  hasError: boolean;
  isLoading: boolean;
  isEmpty: boolean;
  emptyTitle: string;
  onRetry: () => void;
}): React.ReactNode {
  if (authLoading) return <SidebarLoading message="Loading…" />;
  if (!isAdmin) return <SidebarNotice title="Agent sandboxes require administrator privileges" />;
  if (isLoading) return <SidebarLoading message="Loading sessions…" />;
  if (hasError && isEmpty) {
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
  if (isEmpty) return <SidebarNotice title={emptyTitle} />;
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
  onChanged: () => void;
}) {
  const notice = resolveListNotice({
    authLoading,
    isAdmin,
    hasError,
    isLoading,
    isEmpty: sessions.length === 0,
    emptyTitle: driveId ? 'No sessions in this drive yet' : 'No sessions yet',
    onRetry,
  });

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

  // Group by drive in global mode (roster ∪ session-implied drives, Assistant
  // first — see session-groups.ts for the ordering rule); a single implicit
  // group in drive mode, always present (even with zero sessions) so its
  // header — and the header's spawn affordance — never disappears mid-load.
  const groups = useMemo(() => {
    if (driveId) return [{ driveId, driveName: null, sessions }];
    return buildSessionGroups(sessions, { assistant: canSpawn, drives: roster });
  }, [driveId, sessions, canSpawn, roster]);

  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const [spawnTarget, setSpawnTarget] = useState<{ driveId: string | null; driveName: string | null } | null>(null);
  // Set once a target (agent/shell/assistant) is picked in the palette's first
  // step — its presence is what swaps the dialog to the naming step. Null
  // driveId + kind 'assistant' is the only shape the Assistant group's "+"
  // ever produces (it skips the picker entirely, see handleNewSession).
  const [spawnPick, setSpawnPick] = useState<SpawnPick | null>(null);
  const [spawning, setSpawning] = useState(false);

  const spawn = useCallback(
    async (input: { driveId: string | null; agentPageId: string | null; kind: SpawnKind; name: string }) => {
      if (spawning) return;
      setSpawning(true);
      try {
        if (input.kind === 'shell') {
          const created = await post<{ session: { sessionId: string }; shellId: string }>('/api/agent-sessions', {
            driveId: input.driveId,
            firstThing: 'shell',
            name: input.name,
          });
          setSpawnTarget(null);
          setSpawnPick(null);
          onChanged();
          // useAgentSurfaceStore has no shell concept — land by selecting the
          // session there, then placing the pane directly on the workspace
          // store, mirroring AgentPanes.tsx's handleReattachShell.
          selectSession(created.session.sessionId);
          useAgentWorkspaceStore.getState().openConversation(created.session.sessionId, {
            kind: 'terminal',
            name: input.name,
            targetId: created.shellId,
            agentPageId: null,
          });
          return;
        }
        const created = await post<{ session: { sessionId: string }; conversationId: string }>(
          '/api/agent-sessions',
          { driveId: input.driveId, agentPageId: input.agentPageId, name: input.name },
        );
        setSpawnTarget(null);
        setSpawnPick(null);
        onChanged();
        // Land the user IN the new session's first conversation — no empty
        // state is ever visible.
        selectConversation({
          sessionId: created.session.sessionId,
          conversationId: created.conversationId,
          agentId: input.agentPageId,
        });
      } catch (error) {
        console.error('Failed to start a session:', error);
        toast.error('Could not start a session', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      } finally {
        setSpawning(false);
      }
    },
    [spawning, onChanged, selectConversation, selectSession],
  );

  // Sessions are always deliberately named now — both groups open the same
  // naming step. The ASSISTANT group has nothing to pick (the assistant IS
  // the counterpart), so it skips straight to naming; a DRIVE group's "+"
  // opens the picker first so the naming step's placeholder can reflect
  // whichever agent/shell was chosen.
  const handleNewSession = useCallback((groupDriveId: string, groupDriveName: string | null) => {
    if (groupDriveId === ASSISTANT_GROUP_KEY) {
      setSpawnTarget({ driveId: null, driveName: null });
      setSpawnPick({ kind: 'assistant', agentPageId: null, label: 'Assistant' });
      return;
    }
    setSpawnTarget({ driveId: groupDriveId, driveName: groupDriveName });
    setSpawnPick(null);
  }, []);

  const handleSubmitName = useCallback(
    (name: string) => {
      if (!spawnTarget || !spawnPick) return;
      void spawn({ driveId: spawnTarget.driveId, agentPageId: spawnPick.agentPageId, kind: spawnPick.kind, name });
    },
    [spawn, spawnTarget, spawnPick],
  );

  const paletteAgents = useMemo(
    () => (spawnTarget ? (agentsByDrive.find((entry) => entry.driveId === spawnTarget.driveId)?.agents ?? []) : []),
    [agentsByDrive, spawnTarget],
  );

  return (
    <div className="space-y-1">
      {driveId && canSpawn && (
        <SessionGroupHeader label="Agent Sessions" onNewSession={() => handleNewSession(driveId, null)} />
      )}
      {groups.map((group) => (
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
            <SessionRow key={session.sessionId} session={session} onChanged={onChanged} />
          ))}
        </div>
      ))}
      {notice}
      <SpawnSessionPalette
        open={spawnTarget !== null}
        driveName={spawnTarget?.driveName ?? null}
        agents={paletteAgents}
        pick={spawnPick}
        spawning={spawning}
        onOpenChange={(open) => {
          if (open) return;
          setSpawnTarget(null);
          setSpawnPick(null);
        }}
        onPickTarget={setSpawnPick}
        onSubmitName={handleSubmitName}
      />
    </div>
  );
}

/** A group's header row: name (or "Agent Sessions" in drive-scoped mode) plus an inline "+" spawn affordance — condensed in place of a separate full-width row. */
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
    <div className="flex items-center justify-between gap-1 px-2 pb-0.5 pt-1.5">
      <span className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground">{label}</span>
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
function SessionRow({ session, onChanged }: { session: SessionListEntry; onChanged: () => void }) {
  const selectedSessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectedConversationId = useAgentSurfaceStore((state) => state.selectedConversationId);
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const forgetWorkspace = useAgentWorkspaceStore((state) => state.forgetWorkspace);
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

  const openSession = useCallback(() => {
    // Selecting a SESSION opens its most recent conversation — the row is a
    // workspace, and a workspace opens on its work, not on a placeholder.
    setExpanded(true);
    const first = session.conversations[0];
    if (first) openConversation(first);
  }, [openConversation, session.conversations]);

  const newConversation = useCallback(async () => {
    // A new thread defaults to the session's most recent conversation's
    // counterpart — the full drive picker lives in the pane grid. A null
    // agent (a global session, or a drive session whose latest thread is an
    // assistant thread) means the ASSISTANT, created through the
    // session-centric route since it has no agent page.
    const agentPageId = session.conversations[0]?.agentPageId ?? null;
    try {
      const created =
        agentPageId === null
          ? await post<{ conversationId: string }>(
              `/api/agent-sessions/${encodeURIComponent(session.sessionId)}/conversations`,
              {},
            )
          : await post<{ conversationId: string }>(
              `/api/ai/page-agents/${encodeURIComponent(agentPageId)}/conversations`,
              { sessionId: session.sessionId },
            );
      onChanged();
      selectConversation({
        sessionId: session.sessionId,
        conversationId: created.conversationId,
        agentId: agentPageId,
      });
    } catch (error) {
      console.error('Failed to start a conversation:', error);
      toast.error('Could not start a conversation', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    }
  }, [onChanged, selectConversation, session.conversations, session.sessionId]);

  const endSession = useCallback(async () => {
    setEnding(true);
    try {
      await del(`/api/agent-sessions/${encodeURIComponent(session.sessionId)}`);
      // The session leaves the sidebar; its conversations remain as history in
      // each agent's list. Drop the local grid too — its panes pointed at a
      // sandbox that no longer exists.
      forgetWorkspace(session.sessionId);
      if (selectedSessionId === session.sessionId) selectSession(null);
      setConfirmingEnd(false);
      onChanged();
    } catch (error) {
      console.error('Failed to end session:', error);
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setEnding(false);
    }
  }, [forgetWorkspace, onChanged, selectSession, selectedSessionId, session.sessionId]);

  const closeConversation = useCallback(
    async (conversationId: string) => {
      try {
        await del(
          `/api/agent-sessions/${encodeURIComponent(session.sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
        );
        onChanged();
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
      }
    },
    [onChanged, session.sessionId],
  );

  const menuItems: RowMenuItem[] = useMemo(
    () => [
      { label: 'New conversation', icon: MessageSquarePlus, onSelect: () => void newConversation() },
      {
        label: 'End session',
        icon: X,
        onSelect: () => setConfirmingEnd(true),
        destructive: true,
        separatorBefore: true,
      },
    ],
    [newConversation],
  );

  return (
    <div>
      <RowMenu
        items={menuItems}
        menuLabel="Session actions"
        className={cn('gap-1 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent', isSelected && 'bg-accent')}
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
          <span className="truncate">{session.name || 'Session'}</span>
        </button>
        <button
          type="button"
          aria-label="New conversation in this session"
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          onClick={() => void newConversation()}
        >
          <MessageSquarePlus className="size-3.5" />
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
          {session.conversations.map((conversation) => (
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
                <span className="truncate">{conversation.title || 'New conversation'}</span>
              </button>
            </RowMenu>
          ))}
          {session.shells.length > 0 && (
            <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <SquareTerminal className="size-3" aria-hidden="true" />
              {session.shells.length === 1 ? '1 shell' : `${session.shells.length} shells`}
            </div>
          )}
          {session.conversations.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No conversations</div>
          )}
        </div>
      )}
    </div>
  );
}

type SpawnKind = 'agent' | 'shell' | 'assistant';

/** What the palette's first step picked — drives the naming step's placeholder and spawn() call. */
interface SpawnPick {
  kind: SpawnKind;
  agentPageId: string | null;
  /** The sensible default: the agent's title, "Shell", or "Assistant". */
  label: string;
}

/**
 * The spawn palette for a new session, Raycast-style: search or arrow-key to
 * a target and hit Enter — the same keyboard-first pattern `QuickCreatePalette`
 * established for page creation, reused here so a future mouseless-navigation
 * pass has one command-palette idiom to build on, not two. Two steps: pick a
 * target (an agent, Shell, or — for the ASSISTANT group, which skips straight
 * here since it has nothing else to choose — Assistant), then name the
 * session. Naming is always the last step, even for a one-click assistant
 * spawn, so every session gets a deliberate name.
 */
function SpawnSessionPalette({
  open,
  driveName,
  agents,
  pick,
  spawning,
  onOpenChange,
  onPickTarget,
  onSubmitName,
}: {
  open: boolean;
  driveName: string | null;
  agents: DriveWithAgents['agents'];
  pick: SpawnPick | null;
  spawning: boolean;
  onOpenChange: (open: boolean) => void;
  onPickTarget: (pick: SpawnPick) => void;
  onSubmitName: (name: string) => void;
}) {
  const [name, setName] = useState('');

  // Blank by default every time a new naming step starts — a stale typed
  // value from resolving one spawn must never prefill the next.
  useEffect(() => {
    if (open) setName('');
  }, [open, pick]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={pick ? 'Name your session' : 'New session'}
      description={
        pick
          ? `Leave blank to use "${pick.label}"`
          : driveName
            ? `Choose an agent to start a session with in ${driveName}`
            : 'Choose an agent to start a session with'
      }
      showCloseButton={false}
      className="max-w-[420px]"
    >
      {pick ? (
        <form
          className="p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitName(name);
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onSubmitName(name);
            }}
            placeholder={pick.label}
            disabled={spawning}
            className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
        </form>
      ) : (
        <>
          <CommandInput placeholder="Search agents…" autoFocus />
          <CommandList>
            <CommandGroup>
              {agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={`${agent.id}-${agent.title ?? 'Agent'}`}
                  disabled={spawning}
                  onSelect={() => onPickTarget({ kind: 'agent', agentPageId: agent.id, label: agent.title ?? 'Agent' })}
                >
                  <Bot className="size-3.5" aria-hidden="true" />
                  <span className="truncate">{agent.title ?? 'Agent'}</span>
                </CommandItem>
              ))}
              <CommandItem
                value="shell-Shell"
                disabled={spawning}
                onSelect={() => onPickTarget({ kind: 'shell', agentPageId: null, label: 'Shell' })}
              >
                <SquareTerminal className="size-3.5" aria-hidden="true" />
                <span className="truncate">Shell</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </>
      )}
    </CommandDialog>
  );
}

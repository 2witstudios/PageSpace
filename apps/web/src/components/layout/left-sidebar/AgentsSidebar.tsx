'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Bot, ChevronDown, ChevronRight, MessageSquarePlus, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn, isElectron } from '@/lib/utils';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
import DashboardFooter from './DashboardFooter';
import DriveFooter from './DriveFooter';
import PrimaryNavigation from './PrimaryNavigation';
import { SidebarLoading, SidebarNotice } from './sidebar-states';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useDriveStore } from '@/hooks/useDrive';
import { canManageDrive } from '@/hooks/usePermissions';
import { usePageAgents, type AgentSummary, type DriveWithAgents } from '@/hooks/page-agents/usePageAgents';
import { useConversations } from '@/lib/ai/shared';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useUserActiveStreams } from '@/hooks/useUserActiveStreams';
import { deriveRunningBadges, type UserActiveStream } from '@/lib/agents/running-badges';
import { useAgentSurfaceStore, SHEET_BREAKPOINT_QUERY } from '@/stores/agents/useAgentSurfaceStore';
import { post } from '@/lib/auth/auth-fetch';
import { PageType } from '@pagespace/lib/utils/enums';
import { getDefaultContent } from '@pagespace/lib/content/page-types.config';

/**
 * The Agents console's left sidebar: Drive → Agent → Conversation.
 *
 * Two modes, one component (mirroring how `resolveSidebarVariant` routes both
 * Agents URL shapes here):
 *
 * - **Drive-scoped** (`driveId` present): every agent in that drive.
 * - **Global** (`/dashboard/agents`): every agent across every accessible drive,
 *   grouped under a drive header.
 *
 * Structurally this is `DevelopmentSidebar`'s shell — DriveSwitcher →
 * PrimaryNavigation → ScrollArea → footer, the same `resolveListNotice`
 * ordering, the same admin gate — with a completely different tree under it and
 * one behavioural difference that matters more than all of them:
 *
 * **Clicking a row does not navigate.** Selection goes to
 * `useAgentSurfaceStore`, which mirrors it to `?agent=&c=` via `pushState`. The
 * route never changes, so nothing above or beside this component remounts, so
 * live shells and streaming chats survive every click. (That is also why this
 * sidebar has to close the mobile sheet itself — see the store: navigation used
 * to do it for free.)
 *
 * Deliberately NOT carried over from the Development sidebar: `MachineTree`,
 * `WorkspaceLeaves`, `useMachineWorkspaceSync`, and the pending-workspace
 * intent store. Those existed to reconcile a server-synced pane layout across a
 * remount; there is no remount and no server-synced layout here.
 */
export default function AgentsSidebar({ className }: SidebarProps) {
  const params = useParams();
  const [isElectronMac, setIsElectronMac] = useState(false);
  // One matchMedia listener for the whole sidebar, passed down — not one per row.
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

  const {
    agentsByDrive,
    isLoading: agentsLoading,
    isError: agentsError,
    mutate: retryAgents,
  } = usePageAgents(driveId, { enabled: isAdmin });

  const { streams } = useUserActiveStreams({ enabled: isAdmin });

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
          <div className="space-y-1">
            <AgentList
              authLoading={authLoading}
              isAdmin={isAdmin}
              driveId={driveId}
              agentsByDrive={agentsByDrive}
              isLoading={agentsLoading}
              hasError={agentsError}
              onRetry={retryAgents}
              streams={streams}
            />
          </div>
        </ScrollArea>

        {driveId ? <DriveFooter canManage={canManage} /> : <DashboardFooter />}
      </div>
    </aside>
  );
}

/**
 * The one ordering-sensitive guard chain the list needs — carried over verbatim
 * from `DevelopmentSidebar`, along with the reasoning that fixed it there.
 *
 * Order matters: auth-pending and non-admin come first so a cold load or a
 * refused user never sees "Failed"/"empty" wording instead. Loading is checked
 * ahead of error so that a Retry click — which sets `isLoading` back to `true`
 * (SWR does this whenever cached `data` is still `undefined`, exactly the
 * "nothing loaded yet" state a failed fetch leaves behind) while `error` stays
 * at its stale, pre-retry value until the new attempt settles — shows the
 * loading state and not a rerun of the same "Failed" text with no visible
 * reaction to the click. Error is then checked ahead of empty because SWR
 * reports `isLoading: false` with no data on its error path — indistinguishable
 * from "genuinely empty" unless error is checked first — but only when there's
 * nothing to show yet: a background poll's error must not tear down a list the
 * caller already has.
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
  if (isLoading) return <SidebarLoading message="Loading agents…" />;
  if (hasError && isEmpty) {
    return (
      <SidebarNotice
        title="Failed to load agents"
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

/** Stable identity so the per-agent badge memos don't recompute every render. */
const NO_CONVERSATION_IDS: string[] = [];

/**
 * Both modes' list body. The only difference between them is the drive header —
 * the drive-scoped fetch is the global one filtered (same SWR cache, see
 * `usePageAgents`), so there is no second data path to keep in sync.
 */
function AgentList({
  authLoading,
  isAdmin,
  driveId,
  agentsByDrive,
  isLoading,
  hasError,
  onRetry,
  streams,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  driveId: string | undefined;
  agentsByDrive: DriveWithAgents[];
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  streams: UserActiveStream[];
}) {
  // Agent dots come from the streams' own channel ids, so an agent whose
  // conversations have never been expanded still lights up — see
  // `deriveRunningBadges`.
  const agentBadges = useMemo(() => deriveRunningBadges(streams, NO_CONVERSATION_IDS).byAgent, [streams]);

  const notice = resolveListNotice({
    authLoading,
    isAdmin,
    hasError,
    isLoading,
    isEmpty: agentsByDrive.length === 0,
    emptyTitle: driveId ? 'No agents in this drive yet' : 'No agents across your drives yet',
    onRetry,
  });
  if (notice) {
    // A drive with no agents in it yet still needs the one affordance that
    // fixes that — otherwise the empty state is a dead end. Only in
    // drive-scoped mode: the global view has no single drive to create in, and
    // guessing one would put the agent somewhere the user didn't choose.
    if (driveId && isAdmin && !authLoading && !isLoading && !hasError) {
      return (
        <>
          {notice}
          <NewAgentButton driveId={driveId} onCreated={onRetry} />
        </>
      );
    }
    return notice;
  }

  return (
    <>
      {agentsByDrive.map((driveGroup) => (
        <div key={driveGroup.driveId} className="space-y-1">
          {/* Only the aggregated view needs to say which drive a row belongs to. */}
          {!driveId && (
            <div className="px-2 pt-1 text-xs font-normal uppercase tracking-wide text-muted-foreground leading-none">
              {driveGroup.driveName}
            </div>
          )}
          {driveGroup.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} streams={streams} runningCount={agentBadges[agent.id] ?? 0} />
          ))}
          <NewAgentButton driveId={driveGroup.driveId} onCreated={onRetry} />
        </div>
      ))}
    </>
  );
}

/**
 * One agent, and its conversations when expanded.
 *
 * Expansion is what gates the conversations fetch (`enabled`): N agents on
 * screen must not mean N conversation requests on mount, the same reason the
 * Development sidebar's machine rows started collapsed.
 */
function AgentRow({
  agent,
  streams,
  runningCount,
}: {
  agent: AgentSummary;
  streams: UserActiveStream[];
  runningCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const selectedAgentId = useAgentSurfaceStore((state) => state.selectedAgentId);
  const selectedConversationId = useAgentSurfaceStore((state) => state.selectedConversationId);
  const selectAgent = useAgentSurfaceStore((state) => state.selectAgent);
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);

  const onConversationCreate = useCallback(
    (conversationId: string) => {
      // A just-minted id has no server rows — mark it loaded-empty so nothing
      // fetches for it and no loading state shows. (Same move as
      // `usePageAgentDashboardStore.createNewConversation`, which this mirrors.)
      conversationMessagesActions.seedConversation(conversationId);
      selectConversation(conversationId, agent.id);
    },
    [agent.id, selectConversation],
  );

  const { conversations, isLoading, createConversation } = useConversations({
    agentId: agent.id,
    currentConversationId: selectedConversationId,
    enabled: expanded,
    onConversationCreate,
  });

  const conversationIds = useMemo(() => conversations.map((c) => c.id), [conversations]);
  const conversationBadges = useMemo(
    () => deriveRunningBadges(streams, conversationIds).byConversation,
    [streams, conversationIds],
  );

  const title = agent.title || 'Untitled agent';

  return (
    <div>
      <TreeRow
        expanded={expanded}
        onToggleExpand={() => setExpanded((value) => !value)}
        onSelect={() => selectAgent(agent.id)}
        selected={agent.id === selectedAgentId}
        icon={<Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        label={title}
        running={runningCount > 0}
      />

      {expanded && (
        <div className="ml-4 space-y-0.5 border-l border-[var(--separator)] pl-1">
          {isLoading && conversations.length === 0 ? (
            <SidebarLoading message="Loading conversations…" />
          ) : (
            <>
              {conversations.map((conversation) => (
                <TreeRow
                  key={conversation.id}
                  onSelect={() => selectConversation(conversation.id, agent.id)}
                  selected={conversation.id === selectedConversationId}
                  label={conversation.title || 'Untitled conversation'}
                  running={(conversationBadges[conversation.id] ?? 0) > 0}
                />
              ))}
              <InlineAction
                icon={<MessageSquarePlus className="size-3.5 shrink-0" aria-hidden="true" />}
                label="New conversation"
                onClick={() => void createConversation()}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Creating an agent is creating an AI_CHAT page — there is no separate "agent"
 * object, which is exactly why this surface could be built on top of what
 * already exists. Minimal on purpose: the full create flow (icon, prompt,
 * tools) lives on the page itself.
 */
function NewAgentButton({ driveId, onCreated }: { driveId: string; onCreated: () => void }) {
  const [isCreating, setIsCreating] = useState(false);
  const selectAgent = useAgentSurfaceStore((state) => state.selectAgent);

  const createAgent = useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const page = await post<{ id: string }>('/api/pages', {
        title: 'New agent',
        type: PageType.AI_CHAT,
        driveId,
        parentId: null,
        content: getDefaultContent(PageType.AI_CHAT),
      });
      onCreated();
      selectAgent(page.id);
    } catch (error) {
      toast.error((error as Error).message || 'Failed to create agent');
    } finally {
      setIsCreating(false);
    }
  }, [driveId, isCreating, onCreated, selectAgent]);

  return (
    <InlineAction
      icon={<Plus className="size-3.5 shrink-0" aria-hidden="true" />}
      label={isCreating ? 'Creating…' : 'New agent'}
      onClick={() => void createAgent()}
      disabled={isCreating}
    />
  );
}

/** A muted "+ something" row. Reads as an affordance, not as tree content. */
function InlineAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-1 rounded-sm px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
    >
      {icon}
      <span className="truncate leading-none">{label}</span>
    </button>
  );
}

/**
 * One row of the tree. Same shape as the Machine tree's row (expand chevron,
 * label button, `aria-current` on the interactive element rather than the
 * wrapper) so the two surfaces read alike while the doomed component stays
 * where it is.
 */
function TreeRow({
  expanded,
  onToggleExpand,
  onSelect,
  selected,
  icon,
  label,
  running,
}: {
  expanded?: boolean;
  onToggleExpand?: () => void;
  onSelect: () => void;
  selected: boolean;
  icon?: React.ReactNode;
  label: string;
  /** A live assistant stream somewhere under this row. */
  running?: boolean;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-sm py-0.5 pr-1 leading-none',
        // Hover must not fight the selected state: `bg-accent` and
        // `hover:bg-accent/50` are different variant groups, so twMerge keeps
        // both and the hover rule wins — pointing at the selected row would
        // LIGHTEN it, making it read as less selected than its siblings.
        selected ? 'bg-accent' : 'hover:bg-accent/50',
      )}
    >
      {onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="shrink-0 rounded-sm p-0.5 hover:bg-accent"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          data-testid="expand-chevron"
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
      ) : (
        <span className="size-3 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={onSelect}
        // `aria-current` belongs on the INTERACTIVE element, not the row
        // wrapper: the wrapper has no role and isn't focusable, so a
        // screen-reader user never reaches it and the selection would be
        // conveyed by background colour alone.
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        {icon}
        <span className="truncate text-sm font-normal leading-none">{label}</span>
      </button>
      {running && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          role="status"
          aria-label="Running"
          title="Running"
        />
      )}
    </div>
  );
}

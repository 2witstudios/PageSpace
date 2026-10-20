'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { cn } from '../../cn';
import { renderIcon } from '../../components/icon/icon.render';
import { fileHref } from '../../files/files-browser/files-browser-model';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { canManageDrive } from '@/retained/hooks/usePermissions';
import { useDriveEnvs } from '@/retained/hooks/drive-envs/useDriveEnvs';
import { useAppHostingCapability } from '@/retained/hooks/drive-envs/useAppHostingCapability';
import { usePageAgents } from '@/retained/hooks/page-agents/usePageAgents';
import { useSpawnSession } from '@/retained/components/agents/useSpawnSession';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';
import { useAgentSessions, useDriveAgents, usePublishedAppPointers, type AgentSessionRow } from './agents-data';
import {
  agoLabel,
  filterSessions,
  groupSessionsByEnv,
  substrateLabel,
  type SessionGroup,
} from './agents-pane.model';
import { PublishedAppCard } from './published-app-card';

const groupLabelClass =
  'flex items-center gap-2 px-2 pt-3 pb-1 text-2xs font-medium tracking-wide text-ink-muted uppercase';

const sessionRowClass = (selected: boolean): string =>
  cn(
    'flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm',
    selected ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink hover:bg-fill',
  );

/**
 * The Agents tool's pane (C-Drive-Agents): the head with Session, then search, the sessions
 * grouped by their environment, each environment's published app, and the drive's agents.
 * The selected session is the shared agent-surface selection, mirrored to the URL, so the
 * middle follows it and a reload keeps it.
 */
export function AgentsPane({ driveId, close }: ToolPaneProps): ReactNode {
  const drives = useDriveStore((state) => state.drives);
  const drive = drives.find((entry) => entry.id === driveId);
  const driveName = drive?.name ?? null;
  const canManage = canManageDrive(drive);

  const selectedSessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);

  const { sessions, isLoading, error, mutate: refreshSessions } = useAgentSessions(driveId);
  const { envs, mutate: refreshEnvs } = useDriveEnvs(driveId);
  const agents = useDriveAgents(driveId);
  const appCapable = useAppHostingCapability() === true;
  const apps = usePublishedAppPointers(driveId, appCapable);
  const { agentsByDrive } = usePageAgents(undefined, { enabled: true });
  const { openSpawn, paletteElement } = useSpawnSession(agentsByDrive, () => {
    refreshSessions();
    refreshEnvs();
  });

  const [query, setQuery] = useState('');
  const now = new Date();
  const groups = useMemo(() => {
    const matching = filterSessions(sessions, query);
    const all = groupSessionsByEnv(matching, envs);
    return query.trim() === '' ? all : all.filter((group) => group.sessions.length > 0);
  }, [sessions, envs, query]);

  const appEnvIds = new Set(apps.map((app) => app.envId));

  return renderToolPane({
    title: 'Console',
    label: 'Console: agents and sessions',
    actions: (
      <button
        type="button"
        // The tool panes' one primary action, as Calendar's Event: spine blue with its own ink in both themes.
        className="flex h-ask-pill cursor-pointer items-center gap-1 rounded-round border-0 bg-spine px-3 text-sm font-medium text-spine-on disabled:cursor-default disabled:opacity-50"
        disabled={!driveId}
        onClick={() => {
          if (driveId) openSpawn(driveId, driveName);
        }}
      >
        {renderIcon({ name: 'plus', size: 12 })}
        Session
      </button>
    ),
    close,
    children: (
      <>
        <label className="mx-px mb-2 flex h-filter flex-none items-center gap-2 rounded-md bg-fill px-3 text-ink-faint">
          <input
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </label>

        {error ? <p className="px-2 text-sm text-ink-muted">Could not load sessions.</p> : null}
        {!error && isLoading ? <p className="px-2 text-sm text-ink-muted">Loading…</p> : null}
        {!error && !isLoading && sessions.length === 0 ? (
          <p className="px-2 text-sm text-ink-muted">No sessions yet. Start one with Session.</p>
        ) : null}

        {groups.map((group) => (
          <EnvGroup
            key={group.key}
            group={group}
            selectedSessionId={selectedSessionId}
            now={now}
            onSelect={(workspaceId) => selectSession(workspaceId === selectedSessionId ? null : workspaceId)}
            app={
              group.envId !== null && appEnvIds.has(group.envId) && driveId ? (
                <PublishedAppCard driveId={driveId} envId={group.envId} envName={group.name} canManage={canManage} />
              ) : null
            }
          />
        ))}

        <div className={groupLabelClass}>{`Agents in ${driveName ?? 'this drive'}`}</div>
        {agents.map((agent) => (
          <Link
            key={agent.id}
            href={driveId ? fileHref(driveId, agent.id) : '#'}
            prefetch={true}
            className="flex min-h-10 items-center gap-2 rounded-md px-2 py-1 text-ink no-underline hover:bg-fill hover:no-underline"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{agent.title ?? 'Untitled agent'}</span>
              <span className="truncate font-mono text-xs text-ink-muted">{agent.aiModel}</span>
            </span>
          </Link>
        ))}

        {paletteElement}
      </>
    ),
  });
}

function EnvGroup({
  group,
  selectedSessionId,
  now,
  onSelect,
  app,
}: {
  readonly group: SessionGroup;
  readonly selectedSessionId: string | null;
  readonly now: Date;
  readonly onSelect: (workspaceId: string) => void;
  readonly app: ReactNode;
}) {
  return (
    <section aria-label={group.name} className="flex flex-col gap-px">
      <div className={groupLabelClass}>
        <span className="flex-1 truncate">{group.name}</span>
        {group.substrate ? (
          <span className="font-mono text-xs normal-case">{substrateLabel(group.substrate)}</span>
        ) : null}
      </div>
      {group.sessions.map((session) => (
        <SessionRow
          key={session.workspaceId}
          session={session}
          selected={session.workspaceId === selectedSessionId}
          now={now}
          onSelect={onSelect}
        />
      ))}
      {app}
    </section>
  );
}

function SessionRow({
  session,
  selected,
  now,
  onSelect,
}: {
  readonly session: AgentSessionRow;
  readonly selected: boolean;
  readonly now: Date;
  readonly onSelect: (workspaceId: string) => void;
}) {
  const running = session.sandboxStatus === 'running';
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(session.workspaceId)}
      className={sessionRowClass(selected)}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{session.name}</span>
        <span className="text-xs text-ink-muted">{agoLabel(session.lastActiveAt ?? session.createdAt, now)}</span>
      </span>
      {running ? (
        <span role="img" aria-label="Sandbox running" className="size-2 flex-none rounded-full bg-status-success" />
      ) : null}
    </button>
  );
}

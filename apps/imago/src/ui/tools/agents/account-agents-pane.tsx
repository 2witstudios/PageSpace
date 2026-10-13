'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useDriveEnvs } from '@/retained/hooks/drive-envs/useDriveEnvs';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';
import { renderIcon } from '../../components/icon/icon.render';
import { cn } from '../../cn';
import { renderToolPane } from '../../frame/tool-pane/tool-pane.render';
import { useAgentSessions, type AgentSessionRow } from './agents-data';
import { agoLabel, filterSessions, groupSessionsByEnv, type SessionGroup } from './agents-pane.model';
import { envStatusOf, type EnvDotTone } from './account-agents-pane.model';

const groupLabelClass = 'flex items-center gap-2 px-2 pt-3 pb-1 text-2xs font-medium tracking-wide text-ink-muted uppercase';

const toneClass: Readonly<Record<EnvDotTone, string>> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  faint: 'bg-ink-faint',
};

const sessionRowClass = (selected: boolean): string =>
  cn(
    'flex min-h-8 w-full items-center gap-2 rounded-md py-1 pr-2 pl-8 text-left text-sm',
    selected ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink hover:bg-fill',
  );

/**
 * The account's Agents pane (C-Account-Agents): the agent sessions of every drive the viewer can
 * reach, grouped drive → environment, each environment with its status dot. The selected session
 * is the shared agent-surface selection, so the middle follows it. A drive's environments load per
 * drive, so each drive is its own component and the list is the drive list the store holds.
 */
export function AccountAgentsPane(): ReactNode {
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const selectedSessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const { sessions, isLoading, error } = useAgentSessions(undefined);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void fetchDrives();
  }, [fetchDrives]);

  const now = new Date();
  const matching = filterSessions(sessions, query);
  const onSelect = (workspaceId: string) => selectSession(workspaceId === selectedSessionId ? null : workspaceId);

  const driveGroups = drives
    .map((drive) => ({ drive, sessions: matching.filter((session) => session.driveId === drive.id) }))
    .filter((entry) => query.trim() === '' || entry.sessions.length > 0);

  return renderToolPane({
    title: 'Agents',
    label: 'Agent sessions',
    close: null,
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

        {driveGroups.map(({ drive, sessions: driveSessions }) => (
          <DriveSessions
            key={drive.id}
            driveId={drive.id}
            driveName={drive.name}
            sessions={driveSessions}
            selectedSessionId={selectedSessionId}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </>
    ),
  });
}

/** One drive's heading, then its environments with their sessions. */
function DriveSessions({
  driveId,
  driveName,
  sessions,
  selectedSessionId,
  now,
  onSelect,
}: {
  readonly driveId: string;
  readonly driveName: string;
  readonly sessions: readonly AgentSessionRow[];
  readonly selectedSessionId: string | null;
  readonly now: Date;
  readonly onSelect: (workspaceId: string) => void;
}): ReactNode {
  const { envs, isLoading, error } = useDriveEnvs(driveId);
  const groups: SessionGroup[] = isLoading ? [] : groupSessionsByEnv(sessions, envs);

  return (
    <section aria-label={driveName} className="flex flex-col gap-px">
      <div className={groupLabelClass}>{driveName}</div>
      {error ? <p className="px-2 pb-1 text-xs text-ink-muted">Could not load environments.</p> : null}
      {!error && !isLoading && envs.length === 0 ? (
        <p className="px-2 pb-1 text-xs text-ink-muted">No environments in this drive</p>
      ) : null}
      {groups.map((group) => (
        <EnvSessions
          key={group.key}
          group={group}
          selectedSessionId={selectedSessionId}
          now={now}
          onSelect={onSelect}
          status={group.envId === null ? null : envs.find((env) => env.id === group.envId) ?? null}
        />
      ))}
    </section>
  );
}

function EnvSessions({
  group,
  status,
  selectedSessionId,
  now,
  onSelect,
}: {
  readonly group: SessionGroup;
  readonly status: DriveEnvDTO | null;
  readonly selectedSessionId: string | null;
  readonly now: Date;
  readonly onSelect: (workspaceId: string) => void;
}): ReactNode {
  const dot = status === null ? null : envStatusOf(status);
  return (
    <section aria-label={group.name} className="flex flex-col gap-px">
      {status === null ? (
        <div className={groupLabelClass}>{group.name}</div>
      ) : (
        <div className="flex min-h-8 items-center gap-2 px-2 text-sm font-medium text-ink">
          {status.substrate === 'local' ? renderIcon({ name: 'monitor', size: 15, className: 'text-ink-muted' }) : null}
          <span className="flex-1 truncate">{group.name}</span>
          {dot === null ? null : (
            <span role="img" aria-label={dot.label} className={cn('size-2 shrink-0 rounded-full', toneClass[dot.tone])} />
          )}
        </div>
      )}
      {group.sessions.map((session) => (
        <button
          key={session.workspaceId}
          type="button"
          aria-current={session.workspaceId === selectedSessionId ? 'true' : undefined}
          onClick={() => onSelect(session.workspaceId)}
          className={sessionRowClass(session.workspaceId === selectedSessionId)}
        >
          <span className="min-w-0 flex-1 truncate">{session.name}</span>
          <span className="flex-none font-mono text-xs text-ink-muted">
            {agoLabel(session.lastActiveAt ?? session.createdAt, now)}
          </span>
        </button>
      ))}
      {status !== null && group.sessions.length === 0 ? (
        <p className="py-1 pr-2 pl-8 text-xs text-ink-muted">No sessions running in here</p>
      ) : null}
    </section>
  );
}

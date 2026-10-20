'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { paneHeaderClass } from '../../frame/pane/pane-class';
import { headControlClass, headDividerClass } from '../../frame/controls/controls-class';
import { renderIcon } from '../../components/icon/icon.render';
import { dispatch, transactions } from '../../store/transactions';
import EndSessionDialog from '@/retained/components/agents/EndSessionDialog';
import { useSessionRecord } from '@/retained/components/agents/useSessionRecord';
import { DevPreviewAffordance } from '@/retained/components/dev-preview/DevPreviewAffordance';
import { sessionDevPreviewPath } from '@/retained/hooks/dev-preview/useDevPreviewStatus';
import { useDriveEnvs } from '@/retained/hooks/drive-envs/useDriveEnvs';
import { del } from '@/retained/lib/auth/auth-fetch';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';
import { useAgentWorkspaceStore } from '@/retained/stores/agent-workspace/useAgentWorkspaceStore';
import { useAgentSessions } from './agents-data';
import { agoLabel } from './session-label';

export type SessionToolbarProps = {
  readonly driveId?: string;
  /** Show sidebar, while the Console pane is closed. */
  readonly leading?: ReactNode;
  /** The shell's own head controls (the Ask pill while Imago is collapsed). */
  readonly trailing?: ReactNode;
};

/**
 * The Console's one session bar (C-Drive-Agents, "Session"), the head of the middle while a
 * session is open: its name, the environment it runs in and when it started, the sandbox
 * state, the dev-server preview, Add pane, End session and Close. Renders nothing until a
 * session is selected.
 *
 * Close drops the selection without ending anything, the way classic's "All conversations"
 * did: the workspace, its panes, its PTYs and any streaming reply are untouched, and Imago
 * takes the middle back. Add pane asks the pane grid for a new pane with its picker.
 */
export function SessionToolbar({ driveId, leading, trailing }: SessionToolbarProps): ReactNode {
  const sessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const { sessions, mutate: refreshSessions } = useAgentSessions(driveId);
  const record = useSessionRecord(sessionId).data;
  const sessionDriveId = record?.session?.driveId ?? driveId ?? null;
  const { envs } = useDriveEnvs(sessionDriveId);
  const [confirming, setConfirming] = useState(false);

  if (sessionId === null) return null;

  const session = sessions.find((entry) => entry.workspaceId === sessionId);
  const name = session?.name || record?.session?.name || 'Session';
  const envName = session?.envId ? envs.find((env) => env.id === session.envId)?.name : undefined;
  const meta = [envName ? `in ${envName}` : null, session ? `started ${agoLabel(session.createdAt, new Date())}` : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const running = session?.sandboxStatus === 'running' || session?.sandboxStatus === 'starting';

  const endSession = async () => {
    setConfirming(false);
    useAgentWorkspaceStore.getState().forgetWorkspace(sessionId);
    selectSession(null);
    try {
      await del(`/api/agent-workspaces/${encodeURIComponent(sessionId)}`);
      toast.success('Session ended');
    } catch (error) {
      toast.error('Could not end the session', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      refreshSessions();
    }
  };

  const close = () => {
    selectSession(null);
    dispatch(transactions.openImago, undefined);
  };

  return (
    <div role="toolbar" aria-label="Session" className={paneHeaderClass}>
      {leading === undefined || leading === null ? null : (
        <span className="flex flex-none" data-leading="">
          {leading}
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate font-semibold" data-session-name="">
          {name}
        </span>
        {running ? (
          <span role="img" aria-label="Sandbox running" className="size-2 flex-none self-center rounded-full bg-status-success" />
        ) : null}
        {meta === '' ? null : <span className="flex-none truncate text-sm text-ink-muted" data-session-meta="">{meta}</span>}
      </div>
      <DevPreviewAffordance statusPath={sessionDevPreviewPath(sessionId)} sessionId={sessionId} pauseWhenIdle={false} />
      <button
        type="button"
        className={headControlClass}
        aria-label="Add pane"
        title="Add pane"
        onClick={() => useAgentPaneRequestStore.getState().requestAddPane(sessionId)}
      >
        {renderIcon({ name: 'plus', size: 16 })}
      </button>
      {record?.canEndSession === true ? (
        <button
          type="button"
          className="h-head-control flex-none rounded-md border border-status-danger/35 px-3 text-sm text-status-danger"
          onClick={() => setConfirming(true)}
        >
          End session
        </button>
      ) : null}
      {trailing}
      <span className={headDividerClass} aria-hidden="true" />
      <button type="button" className={headControlClass} aria-label="Close session" title="Close session" onClick={close}>
        {renderIcon({ name: 'close', size: 12 })}
      </button>
      <EndSessionDialog
        open={confirming}
        onOpenChange={setConfirming}
        sessionName={session?.name ?? record?.session?.name ?? null}
        onConfirm={() => void endSession()}
      />
    </div>
  );
}

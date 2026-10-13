'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import EndSessionDialog from '@/retained/components/agents/EndSessionDialog';
import { useSessionRecord } from '@/retained/components/agents/useSessionRecord';
import { DevPreviewAffordance } from '@/retained/components/dev-preview/DevPreviewAffordance';
import { sessionDevPreviewPath } from '@/retained/hooks/dev-preview/useDevPreviewStatus';
import { useDriveEnvs } from '@/retained/hooks/drive-envs/useDriveEnvs';
import { del } from '@/retained/lib/auth/auth-fetch';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';
import { useAgentWorkspaceStore } from '@/retained/stores/agent-workspace/useAgentWorkspaceStore';
import { useAgentSessions, useDriveAgents } from './agents-data';
import { agoLabel } from './agents-pane.model';

/**
 * The 44px toolbar over the selected session (C-Drive-Agents, "Session"): the agent, its
 * environment and when it started, the sandbox state, the preview affordance, and End
 * session. Renders nothing until a session is selected.
 *
 * Add pane asks the pane grid to split the active pane into its picker. Not yet here
 * (needs-api): the sandbox size and the wallet funding line.
 */
export function SessionToolbar({ driveId }: { readonly driveId?: string }): ReactNode {
  const sessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectedAgentId = useAgentSurfaceStore((state) => state.selectedAgentId);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const { sessions, mutate: refreshSessions } = useAgentSessions(driveId);
  const record = useSessionRecord(sessionId).data;
  const sessionDriveId = record?.session?.driveId ?? driveId ?? null;
  const { envs } = useDriveEnvs(sessionDriveId);
  const agents = useDriveAgents(sessionDriveId);
  const [confirming, setConfirming] = useState(false);

  if (sessionId === null) return null;

  const session = sessions.find((entry) => entry.workspaceId === sessionId);
  const agentTitle = agents.find((agent) => agent.id === selectedAgentId)?.title ?? null;
  const envName = session?.envId ? envs.find((env) => env.id === session.envId)?.name : undefined;
  const label = [
    agentTitle ?? session?.name ?? record?.session?.name ?? 'Session',
    envName ? `env ${envName}` : null,
    session ? `started ${agoLabel(session.createdAt, new Date())}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const running = session?.sandboxStatus === 'running';

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

  return (
    <ToolbarStrip label="Session">
      <span className="min-w-0 truncate text-sm text-ink">{label}</span>
      {running ? (
        <span className="ml-2 inline-flex h-6 flex-none items-center gap-2 rounded-full bg-status-success/10 px-3 text-xs font-medium text-status-success">
          <span className="size-2 rounded-full bg-status-success" aria-hidden="true" />
          Sandbox running
        </span>
      ) : null}
      <DevPreviewAffordance
        statusPath={sessionDevPreviewPath(sessionId)}
        sessionId={sessionId}
        pauseWhenIdle={false}
        className="ml-auto"
      />
      <button
        type="button"
        className="ml-2 h-8 flex-none rounded-md border border-hairline px-3 text-sm text-ink"
        onClick={() => useAgentPaneRequestStore.getState().requestAddPane(sessionId)}
      >
        Add pane
      </button>
      {record?.canEndSession === true ? (
        <button
          type="button"
          className="ml-2 h-8 flex-none rounded-md border border-status-danger/35 px-3 text-sm text-status-danger"
          onClick={() => setConfirming(true)}
        >
          End session
        </button>
      ) : null}
      <EndSessionDialog
        open={confirming}
        onOpenChange={setConfirming}
        sessionName={session?.name ?? record?.session?.name ?? null}
        onConfirm={() => void endSession()}
      />
    </ToolbarStrip>
  );
}

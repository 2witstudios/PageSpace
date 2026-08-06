/**
 * Broadcasting for agent-workspace pane-grid events (epic Phase 3).
 *
 * One event, one room: `workspace:updated` — a rev-carrying snapshot of a
 * session's pane grid after an applied layout verb (or a legacy blob PUT
 * that changed the rows) — fans out to the workspace's `session:<id>` room
 * (`sessionRoom`, `@pagespace/lib/realtime/rooms`). Fire-and-forget over the
 * same signed `/api/broadcast` path every other web emitter uses: transport
 * is best-effort by design; correctness comes from the rev + snapshot
 * refetch on the subscriber side, never from delivery guarantees.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import { sessionRoom } from '@pagespace/lib/realtime/rooms';
import type { WorkspaceLayoutGridDTO } from '@pagespace/lib/agent-sessions/workspace-layout-verbs';
import { maskIdentifier } from '@/lib/logging/mask';

const realtimeLogger = browserLoggers.realtime.child({ module: 'agent-workspace-events' });

const getEnvVar = (name: string, fallback = '') => {
  if (isNodeEnvironment()) {
    return process.env[name] || fallback;
  }
  return fallback;
};

export interface WorkspaceUpdatedPayload {
  /** The session whose grid changed (`agent_sessions.id`). */
  workspaceId: string;
  /** The post-write rev — subscribers apply on `watermark + 1`, refetch on a gap. */
  rev: number;
  /** The verb type that caused the change (`'legacy_replace'` for a blob PUT). */
  verb: string;
  /** The full post-write grid — small enough to always ship whole. */
  grid: WorkspaceLayoutGridDTO;
}

/**
 * Fire-and-forget: broadcast failures are logged, never thrown — a layout
 * write must not fail because the realtime service hiccuped.
 */
export function broadcastWorkspaceUpdated(payload: WorkspaceUpdatedPayload): void {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping workspace event broadcast', {
      workspaceId: maskIdentifier(payload.workspaceId),
    });
    return;
  }

  const requestBody = JSON.stringify({
    channelId: sessionRoom(payload.workspaceId),
    event: 'workspace:updated',
    payload,
  });

  void fetch(`${realtimeUrl}/api/broadcast`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(requestBody),
    body: requestBody,
    signal: AbortSignal.timeout(5000),
  }).catch((error: unknown) => {
    realtimeLogger.error(
      'Failed to broadcast workspace event',
      error instanceof Error ? error : undefined,
      { workspaceId: maskIdentifier(payload.workspaceId) },
    );
  });
}

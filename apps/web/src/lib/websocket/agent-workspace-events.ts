/**
 * Broadcasting for agent-workspace pane-grid events (epic Phase 3).
 *
 * One event, one room: `workspace:updated` — a rev-carrying snapshot of a
 * session's pane grid after an applied layout verb — fans out to the
 * workspace's `session:<id>` room
 * (`sessionRoom`, `@pagespace/lib/realtime/rooms`). Fire-and-forget over the
 * same signed `/api/broadcast` path every other web emitter uses: transport
 * is best-effort by design; correctness comes from the rev + snapshot
 * refetch on the subscriber side, never from delivery guarantees.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import { sessionRoom } from '@pagespace/lib/realtime/rooms';
import type { WorkspaceLayoutGridDTO, WorkspaceLayoutVerb } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { maskIdentifier } from '@/lib/logging/mask';

const realtimeLogger = browserLoggers.realtime.child({ module: 'agent-workspace-events' });

const getEnvVar = (name: string, fallback = '') => {
  if (isNodeEnvironment()) {
    return process.env[name] || fallback;
  }
  return fallback;
};

export interface WorkspaceUpdatedPayload {
  /** The session whose grid changed (`agent_workspaces.id`). */
  workspaceId: string;
  /** The post-write rev — subscribers apply on `watermark + 1`, refetch on a gap. */
  rev: number;
  /**
   * The verb type that caused the change.
   *
   * Typed against the verb union rather than a bare `string`: every change now
   * comes from a verb (the blob PUT that used to send `'legacy_replace'` is a
   * 410), so there is no longer any value here that is not one of them.
   */
  verb: WorkspaceLayoutVerb['type'];
  /**
   * The client-minted idempotency key of the verb that caused the change —
   * how a subscriber recognizes its OWN echo. A client whose POST is still
   * unanswered must NOT adopt this event: its own 200/409 is the
   * authoritative answer and is already on the wire, and adopting the echo
   * would replay a still-queued verb onto a grid that already contains it
   * (a `split_right` replayed that way re-inserts its own minted column id).
   *
   * Nullable for a change no verb caused. Nothing produces that today — the
   * blob PUT that did is retired and the one emit site always supplies an opId
   * — but the field stays nullable rather than being tightened on the strength
   * of there being no such writer at this moment.
   */
  opId: string | null;
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

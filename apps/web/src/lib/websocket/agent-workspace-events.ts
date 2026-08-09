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
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
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
  emit('workspace:updated', payload.workspaceId, payload);
}

/**
 * The NODE model's broadcast: `workspace:nodes-updated`, the flat list after an
 * applied write.
 *
 * **STRUCTURAL, and that is the whole design.** `session:<id>` is a room — one
 * payload reaches every member of a shared workspace at once — so there is no
 * viewer to redact for and per-viewer redaction is not expressible on this wire.
 * The tree is identical for every member (ids, parents, positions, shares, and
 * which target each pane points at), so it ships whole; the TITLES do not ship
 * at all, because a title is authority and this wire cannot ask whose. That is
 * the structural reason `targets[]` rides beside the nodes on the HTTP reads
 * instead of inside them: a shape that put the title on the node would have
 * nothing safe to broadcast.
 *
 * A subscriber that meets a target it cannot name resolves it through its OWN
 * access-checked read.
 *
 * There is no `opId` here and no successor to one. The old event carried the
 * client-minted key so a client could recognize its own echo and refuse to
 * replay a still-queued verb; the node write is an UPSERT of a set, so applying
 * one's own echo is idempotent and there is nothing left to recognize.
 */
export interface WorkspaceNodesUpdatedPayload {
  workspaceId: string;
  /** The post-write rev — subscribers apply on `watermark + 1`, refetch on a gap. */
  rev: number;
  /** The whole flat list after the write. Small enough to always ship whole. */
  nodes: WorkspaceNode[];
}

export function broadcastWorkspaceNodesUpdated(payload: WorkspaceNodesUpdatedPayload): void {
  emit('workspace:nodes-updated', payload.workspaceId, payload);
}

/**
 * Fire-and-forget: broadcast failures are logged, never thrown — a layout
 * write must not fail because the realtime service hiccuped.
 */
function emit(event: string, workspaceId: string, payload: unknown): void {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping workspace event broadcast', {
      workspaceId: maskIdentifier(workspaceId),
    });
    return;
  }

  const requestBody = JSON.stringify({
    channelId: sessionRoom(workspaceId),
    event,
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
      { workspaceId: maskIdentifier(workspaceId) },
    );
  });
}

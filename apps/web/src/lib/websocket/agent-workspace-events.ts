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
import { sessionRoom, userSessionsRoom } from '@pagespace/lib/realtime/rooms';
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
  emit({
    event: 'workspace:updated',
    workspaceId: payload.workspaceId,
    channelId: sessionRoom(payload.workspaceId),
    payload,
  });
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
  /**
   * The workspace's OWNER, so the event can also reach their own sessions room.
   * Read inside the write's transaction (never as a query on the hot path) and
   * omitted only when the workspace row has vanished under the write.
   */
  ownerId?: string | null;
}

/**
 * TWO ROOMS, AND EXACTLY TWO.
 *
 * `session:<id>` is the room the workspace's own surface joins — every member of
 * a shared workspace, but only while a grid for it is actually mounted. That is
 * the whole problem this epic opened with: a pane an agent placed in a workspace
 * the user was not looking at reached nobody, so the sidebar learned about it
 * from the 120s backstop poll. Up to two minutes to draw a row.
 *
 * `user:<ownerId>:sessions` is the owner's own directory plane — joined
 * AUTOMATICALLY at connect, for exactly one user, and already the room every
 * `conversation:*` and `session:*` directory event rides. Adding the node
 * broadcast to it is what makes the sidebar live for its owner without mounting
 * fifty per-workspace listeners.
 *
 * **Do NOT generalise this to `drive:<driveId>`.** It looks like the obvious next
 * step and it is a disclosure. `decideAgentSessionAccess` admits any member of
 * the workspace's drive, but `listSessions` filters on `ownerId` — so a drive
 * member is told nothing about which workspaces their colleagues own. A drive
 * room would hand every member a rev-bumping event per workspace id, which is a
 * workspace-ENUMERATION oracle over the whole drive, and the payload is
 * structural precisely so it can be broadcast to a room without a viewer to
 * redact for. Two rooms whose membership is already implied by what the reader
 * can list is the boundary; a third is not.
 *
 * Double delivery to a user who is BOTH the owner and has the grid mounted is
 * safe and expected: the subscriber's rev guard drops the second copy, and it is
 * armed synchronously by the first.
 */
export function broadcastWorkspaceNodesUpdated(payload: WorkspaceNodesUpdatedPayload): void {
  const { ownerId, ...structural } = payload;
  emit({
    event: 'workspace:nodes-updated',
    workspaceId: payload.workspaceId,
    channelId: sessionRoom(payload.workspaceId),
    payload: structural,
  });
  if (ownerId) {
    emit({
      event: 'workspace:nodes-updated',
      workspaceId: payload.workspaceId,
      channelId: userSessionsRoom(ownerId),
      payload: structural,
    });
  }
}

/**
 * Fire-and-forget: broadcast failures are logged, never thrown — a layout write
 * must not fail because the realtime service hiccuped.
 *
 * **It takes an OPTIONS OBJECT, and naming the event at the call site is
 * load-bearing beyond readability.** `conversation-events-audience.test.ts`
 * scans every source file in `apps/` and `packages/` for an event-name literal
 * in that named position, and asserts the result against a hand-maintained
 * registry of who may broadcast what — the thing that stops a new emitter
 * reaching a room nobody reviewed. An earlier refactor made the name a
 * POSITIONAL argument, which is invisible to that scan: this file silently
 * dropped out of the registry, and its broadcasts stopped being covered by the
 * very check that exists to notice a new one. Passing it as a named literal puts
 * it back. Do not turn it into a bare parameter again.
 */
function emit(input: { event: string; workspaceId: string; channelId: string; payload: unknown }): void {
  const { event, workspaceId, channelId, payload } = input;
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping workspace event broadcast', {
      workspaceId: maskIdentifier(workspaceId),
    });
    return;
  }

  const requestBody = JSON.stringify({
    channelId,
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

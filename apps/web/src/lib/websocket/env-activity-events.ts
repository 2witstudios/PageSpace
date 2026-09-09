/**
 * Broadcasting for a local environment's ACTIVITY — the server-side grant
 * audit, live (GA wave 3, leaf 2).
 *
 * One event: `env:activity`, carrying one `DriveEnvActivityDTO` — the audit
 * row as written at sign time and again as updated at result time — fanned
 * out to exactly ONE room: `user:<ownerId>:sessions`, the machine OWNER's own
 * directory plane, joined automatically at connect. That room is the whole
 * audience by design:
 *
 * - A machine is driven by its owner only ([D-6], invariant 13), and what
 *   runs on it is the owner's to see. The activity routes are owner-only for
 *   the same reason; the live feed must not be wider than the read.
 * - The payload names a COMMAND (`summary`) — the one thing on the wire here a
 *   person is meant to read — so it must never reach a drive room: a drive
 *   member who is not the owner would learn what the owner's agent ran on the
 *   owner's laptop. The drive-room enumeration argument in
 *   `agent-workspace-events.ts` applies with more force here.
 * - The principal (`userId`) may differ from the owner in the future ([D-4],
 *   global assistant); the room is keyed on the OWNER regardless, because it
 *   is the owner's machine that acted.
 *
 * Fire-and-forget over the same signed `/api/broadcast` path every other web
 * emitter uses: a grant must never fail because the realtime service
 * hiccuped, and the subscriber re-reads on reconnect. `event` is passed as a
 * named literal for the emit-site registry scan (see that file's note).
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import { userSessionsRoom } from '@pagespace/lib/realtime/rooms';
import type { DriveEnvActivityDTO } from '@pagespace/lib/drive-envs/env-contract';
import { maskIdentifier } from '@/lib/logging/mask';

const realtimeLogger = browserLoggers.realtime.child({ module: 'env-activity-events' });

const getEnvVar = (name: string, fallback = '') => {
  if (isNodeEnvironment()) {
    return process.env[name] || fallback;
  }
  return fallback;
};

export interface EnvActivityBroadcastInput {
  /** `drive_env_local.ownerId` — the ONLY recipient. */
  ownerId: string;
  activity: DriveEnvActivityDTO;
}

/** One audit row, written or updated, to its machine's owner. Never throws. */
export function broadcastEnvActivity(input: EnvActivityBroadcastInput): void {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping env activity broadcast', {
      envId: maskIdentifier(input.activity.envId),
    });
    return;
  }

  const requestBody = JSON.stringify({
    channelId: userSessionsRoom(input.ownerId),
    event: 'env:activity',
    payload: input.activity,
  });

  void fetch(`${realtimeUrl}/api/broadcast`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(requestBody),
    body: requestBody,
    signal: AbortSignal.timeout(5000),
  }).catch((error: unknown) => {
    realtimeLogger.error(
      'Failed to broadcast env activity',
      error instanceof Error ? error : undefined,
      { envId: maskIdentifier(input.activity.envId) },
    );
  });
}

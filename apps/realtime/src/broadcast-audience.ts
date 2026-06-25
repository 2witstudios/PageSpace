/**
 * Broadcast Audience Authorization (#972)
 *
 * GDPR Art 5(1)(c) data minimization + Art 32 security of processing.
 *
 * The `POST /api/broadcast` HTTP endpoint authenticates the SENDER with an HMAC
 * signature (verifyBroadcastSignature), proving the request came from the web
 * backend. The signature does NOT constrain the AUDIENCE: the handler used to
 * call `io.to(channelId).emit(event, payload)` for whatever `channelId` the body
 * named, trusting the caller wholesale. A malformed, wildcard, or otherwise
 * unexpected channelId would fan a payload out to an unintended Socket.IO room.
 *
 * This module adds a PURE, deterministic structural check on the audience: it
 * accepts only channelId shapes that the realtime server actually joins sockets
 * into, and rejects everything else even when the signature is valid.
 *
 * --- Allowed room-identifier shapes (derived from src/index.ts socket.join calls) ---
 * Every room a socket can legitimately occupy is created by one of these joins,
 * so a broadcast can only ever have a real audience if its channelId matches one
 * of them. `<cuid>` is a CUID2 (validated by isCUID2 from ./validation):
 *
 *   <cuid>                       page / channel room        (index.ts:656 socket.join(pageId); presence io.to(pageId):940)
 *   notifications:<cuid>         per-user notifications      (index.ts:619,624)
 *   user:<cuid>:tasks            per-user task feed          (index.ts:620,625)
 *   user:<cuid>:calendar         per-user calendar feed      (index.ts:621,626)
 *   user:<cuid>:drives           per-user drive list         (index.ts:622,627)
 *   user:<cuid>:global           per-user global assistant   (index.ts:623,628 via globalChannelId)
 *   drive:<cuid>                 drive room                  (index.ts:698)
 *   drive:<cuid>:calendar        drive calendar room         (index.ts:699)
 *   dm:<cuid>                    direct-message conversation (index.ts:753)
 *   activity:drive:<cuid>        drive activity feed         (index.ts:821)
 *   activity:page:<cuid>         page activity feed          (index.ts:848)
 *
 * NOTE on residual scope (intentional structural-only check): the realtime
 * server cannot, without a DB call, know whether the *specific* drive/page/user/
 * conversation referenced is a real entity or whether a given recipient is
 * authorized to be in that room. Those authorization checks are already enforced
 * at JOIN time by the socket handlers (getUserAccessLevel / getUserDriveAccess /
 * DM participant filter-in-query). A broadcast can therefore only reach sockets
 * that were already admitted to the room. What this validator adds is hardening
 * of the SHAPE of the audience target so a signed-but-hostile/malformed request
 * cannot address a wildcard, an arbitrary prefix, or a non-room string. This is
 * the strongest authorization enforceable purely (no I/O) on the broadcast path;
 * the entity/membership layer is upheld by the join handlers, not here.
 */

import { isCUID2 } from './validation';

export interface BroadcastAudienceInput {
  channelId: string;
  event: string;
  payload: unknown;
}

export interface BroadcastAudienceResult {
  allowed: boolean;
  reason?: string;
}

/** Suffix-keyed `user:<cuid>:<suffix>` rooms that index.ts joins. */
const USER_SUFFIXES = new Set(['tasks', 'calendar', 'drives', 'global']);

/** `activity:<scope>:<cuid>` scopes that index.ts joins. */
const ACTIVITY_SCOPES = new Set(['drive', 'page']);

/**
 * Returns true iff `channelId` matches one of the room-identifier shapes that
 * the realtime server actually joins sockets into. Pure; no side effects.
 */
function isAllowedRoomShape(channelId: string): boolean {
  const segments = channelId.split(':');

  // Bare pageId / channelId room: a CUID2 with no prefix.
  if (segments.length === 1) {
    return isCUID2(channelId);
  }

  // notifications:<cuid>
  if (segments.length === 2 && segments[0] === 'notifications') {
    return isCUID2(segments[1]);
  }

  // dm:<cuid>
  if (segments.length === 2 && segments[0] === 'dm') {
    return isCUID2(segments[1]);
  }

  // drive:<cuid>
  if (segments.length === 2 && segments[0] === 'drive') {
    return isCUID2(segments[1]);
  }

  // drive:<cuid>:calendar
  if (segments.length === 3 && segments[0] === 'drive' && segments[2] === 'calendar') {
    return isCUID2(segments[1]);
  }

  // user:<cuid>:<suffix>
  if (segments.length === 3 && segments[0] === 'user' && USER_SUFFIXES.has(segments[2])) {
    return isCUID2(segments[1]);
  }

  // activity:<scope>:<cuid>
  if (segments.length === 3 && segments[0] === 'activity' && ACTIVITY_SCOPES.has(segments[1])) {
    return isCUID2(segments[2]);
  }

  return false;
}

/**
 * Authorize a broadcast's audience target before emitting.
 *
 * Validates that the required fields are present and well-typed and that the
 * channelId names a legitimate room shape. Returns `{ allowed: false, reason }`
 * for any malformed or disallowed audience, `{ allowed: true }` otherwise.
 *
 * Pure and referentially transparent: same input → same output, no mutation,
 * no I/O.
 */
export function authorizeBroadcastAudience(input: BroadcastAudienceInput): BroadcastAudienceResult {
  const { channelId, event, payload } = input;

  if (typeof channelId !== 'string' || channelId.length === 0) {
    return { allowed: false, reason: 'channelId must be a non-empty string' };
  }

  if (typeof event !== 'string' || event.length === 0) {
    return { allowed: false, reason: 'event must be a non-empty string' };
  }

  if (payload === undefined || payload === null) {
    return { allowed: false, reason: 'payload is required' };
  }

  if (!isAllowedRoomShape(channelId)) {
    return { allowed: false, reason: 'channelId does not match an allowed room shape' };
  }

  return { allowed: true };
}

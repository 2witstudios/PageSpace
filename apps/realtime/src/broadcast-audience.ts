/**
 * Broadcast Audience Authorization (#972, grammar centralized by #2158)
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
 * The room-name grammar itself lives in @pagespace/lib/realtime/rooms — the
 * same module the join sites in src/index.ts build their room names from — so
 * this validator can no longer drift from the joins (this file used to carry a
 * hand-maintained copy of the shape list, annotated with index.ts line numbers
 * that had rotted ~300 lines stale). The drift guard
 * (__tests__/room-grammar-drift-guard.test.ts) asserts every builder output is
 * accepted here and that no realtime source hand-rolls a room name.
 *
 * NOTE on residual scope (intentional structural-only check): the realtime
 * server cannot, without a DB call, know whether the *specific* drive/page/user/
 * conversation referenced is a real entity or whether a given recipient is
 * authorized to be in that room. Those authorization checks are already enforced
 * at JOIN time by the socket handlers (getUserAccessLevel / getUserDriveAccess /
 * DM participant filter-in-query) and re-checked per sensitive event
 * (./per-event-auth.ts). A broadcast can therefore only reach sockets that were
 * already admitted to the room. What this validator adds is hardening of the
 * SHAPE of the audience target so a signed-but-hostile/malformed request cannot
 * address a wildcard, an arbitrary prefix, or a non-room string. This is the
 * strongest authorization enforceable purely (no I/O) on the broadcast path;
 * the entity/membership layer is upheld by the join handlers, not here.
 */

import { isKnownRoomId } from '@pagespace/lib/realtime/rooms';

export interface BroadcastAudienceInput {
  channelId: string;
  event: string;
  payload: unknown;
}

export interface BroadcastAudienceResult {
  allowed: boolean;
  reason?: string;
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

  if (!isKnownRoomId(channelId)) {
    return { allowed: false, reason: 'channelId does not match an allowed room shape' };
  }

  return { allowed: true };
}

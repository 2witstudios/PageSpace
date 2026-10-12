/**
 * SEC-2/SEC-3 for long-lived sockets (D-OW-45): which org-gated rooms a socket's credential may no longer hold, and
 * when to look again. A join is checked once; a credential ages while the socket stays open, so an org's maximum
 * session age must evict it from that org's rooms when it elapses. Pure: the socket/timer wiring is org-room-watch.
 */
import { decideActorAuthentication, type AccessActor, type OrgAuthenticationDenialCode } from '@pagespace/lib/permissions/access-actor';

type OrgAuthenticationPolicy = NonNullable<Parameters<typeof decideActorAuthentication>[0]['policy']>;

/** A room the socket joined through an access check on a page or drive, and the sign-in policy governing it. */
export interface JoinedOrgRoom {
  readonly room: string;
  readonly resourceId: string;
  /** The governing org's sign-in policy; null for a resource no org governs. */
  readonly policy: OrgAuthenticationPolicy | null;
}

export interface OrgRoomExpiryPlan {
  readonly expired: ReadonlyArray<{ readonly room: string; readonly resourceId: string; readonly code: OrgAuthenticationDenialCode }>;
  /** When the earliest still-held room expires (capped so a timer never overflows); null when none ever will. */
  readonly nextCheckAtMs: number | null;
}

/** setTimeout's delay is a signed 32-bit int; a 30-day maximum age re-checks once a day instead. */
export const MAX_TIMER_DELAY_MS = 24 * 60 * 60_000;

export function planOrgRoomExpiry(input: {
  readonly actor: AccessActor;
  readonly rooms: readonly JoinedOrgRoom[];
  readonly nowMs: number;
}): OrgRoomExpiryPlan {
  const { actor, rooms, nowMs } = input;
  const expired: Array<{ room: string; resourceId: string; code: OrgAuthenticationDenialCode }> = [];
  let earliest: number | null = null;
  for (const { room, resourceId, policy } of rooms) {
    const decision = decideActorAuthentication({ actor, policy, nowMs });
    if (!decision.allowed) {
      expired.push({ room, resourceId, code: decision.code });
      continue;
    }
    const maxAgeMinutes = policy?.maximumSessionAgeMinutes ?? null;
    if (maxAgeMinutes === null || actor.via !== 'credential' || actor.authentication === null) continue;
    const expiresAtMs = actor.authentication.authenticatedAtMs + maxAgeMinutes * 60_000;
    earliest = earliest === null ? expiresAtMs : Math.min(earliest, expiresAtMs);
  }
  return { expired, nextCheckAtMs: earliest === null ? null : Math.min(earliest, nowMs + MAX_TIMER_DELAY_MS) };
}

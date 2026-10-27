import { describe, expect, it } from 'vitest';
import { automationActor, credentialActor, inDrives } from '@pagespace/lib/permissions/access-actor';
import { planOrgRoomExpiry, MAX_TIMER_DELAY_MS } from '../org-room-expiry';

const nowMs = Date.parse('2026-10-12T12:00:00Z');
const minutes = (n: number) => n * 60_000;
const maxAge = (m: number) => ({ requireStrongSignIn: false, maximumSessionAgeMinutes: m });
const signedIn = (agoMs: number) => credentialActor('u', { authenticatedAtMs: nowMs - agoMs, assurance: 'single_factor' });

describe('planOrgRoomExpiry', () => {
  it('fails closed: an automation actor holding a room outside its drive scope is told to sign in again', () => {
    const actor = automationActor('u', 'room expiry test', inDrives('other'));
    const plan = planOrgRoomExpiry({ actor, rooms: [{ room: 'drive:a', resourceId: 'a', policy: maxAge(60) }], nowMs });
    expect(plan.expired).toEqual([{ room: 'drive:a', resourceId: 'a', code: 'org_reauthentication_required' }]);
  });

  it('SEC-3 (partial) rooms of orgs without a sign-in policy never expire and arm no timer', () => {
    const plan = planOrgRoomExpiry({ actor: signedIn(minutes(5)), rooms: [{ room: 'drive:p', resourceId: 'p', policy: null }], nowMs });
    expect(plan).toEqual({ expired: [], nextCheckAtMs: null });
  });

  it('SEC-3 (partial) the timer is armed at the EARLIEST expiry among the joined org rooms', () => {
    const plan = planOrgRoomExpiry({
      actor: signedIn(minutes(10)),
      rooms: [
        { room: 'drive:a', resourceId: 'a', policy: maxAge(60) },
        { room: 'drive:b', resourceId: 'b', policy: maxAge(15) },
      ],
      nowMs,
    });
    expect(plan.expired).toEqual([]);
    expect(plan.nextCheckAtMs).toBe(nowMs + minutes(5));
  });

  it('SEC-3 (partial) a room whose org maximum age has elapsed is expired with the reauthentication code', () => {
    const plan = planOrgRoomExpiry({
      actor: signedIn(minutes(20)),
      rooms: [
        { room: 'drive:a', resourceId: 'a', policy: maxAge(60) },
        { room: 'drive:b', resourceId: 'b', policy: maxAge(15) },
      ],
      nowMs,
    });
    expect(plan.expired).toEqual([{ room: 'drive:b', resourceId: 'b', code: 'org_reauthentication_required' }]);
    expect(plan.nextCheckAtMs).toBe(nowMs + minutes(40));
  });

  it('SEC-2 (partial) a room of an org requiring strong sign-in is expired for a single-factor credential', () => {
    const plan = planOrgRoomExpiry({
      actor: signedIn(minutes(1)),
      rooms: [{ room: 'p1', resourceId: 'p1', policy: { requireStrongSignIn: true, maximumSessionAgeMinutes: null } }],
      nowMs,
    });
    expect(plan.expired).toEqual([{ room: 'p1', resourceId: 'p1', code: 'org_strong_sign_in_required' }]);
    expect(plan.nextCheckAtMs).toBeNull();
  });

  it('SEC-3 (partial) a far expiry is re-checked no later than the longest safe timer delay', () => {
    const plan = planOrgRoomExpiry({ actor: signedIn(0), rooms: [{ room: 'd', resourceId: 'd', policy: maxAge(43_200) }], nowMs });
    expect(plan.nextCheckAtMs).toBe(nowMs + MAX_TIMER_DELAY_MS);
  });
});

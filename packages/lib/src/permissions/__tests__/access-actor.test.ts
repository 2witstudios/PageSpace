import { describe, expect, it } from 'vitest';
import { automationActor, credentialActor, decideActorAuthentication, derivedCredentialEvidence, HELD_DRIVES, inDrives, type AccessActor } from '../access-actor';
import type { OrgAuthenticationPolicy } from '../../organizations/authentication-policy-core';

const nowMs = Date.parse('2026-10-12T12:00:00Z');
const strongSignIn: OrgAuthenticationPolicy = { requireStrongSignIn: true, maximumSessionAgeMinutes: null };
const maxAgeHour: OrgAuthenticationPolicy = { requireStrongSignIn: false, maximumSessionAgeMinutes: 60 };
const passkey = { authenticatedAtMs: nowMs - 1000, assurance: 'user_verified_passkey' as const };
const magicLink = { authenticatedAtMs: nowMs - 1000, assurance: 'single_factor' as const };

describe('access actor', () => {
  it('a credential actor carries its user and ceremony evidence, frozen', () => {
    const actor = credentialActor('user-1', passkey);
    expect(actor).toEqual({ via: 'credential', userId: 'user-1', authentication: passkey });
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('a credential actor without evidence carries null, never undefined', () => {
    expect(credentialActor('user-1', undefined)).toEqual({ via: 'credential', userId: 'user-1', authentication: null });
  });

  it('an automation actor names why it runs and is frozen', () => {
    const actor = automationActor('user-1', 'workflow', inDrives('drive-1'));
    expect(actor).toEqual({ via: 'automation', userId: 'user-1', reason: 'workflow', scope: { kind: 'drives', driveIds: ['drive-1'] } });
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('an actor cannot be forged: neither a user id nor a hand-written literal type-checks as one', () => {
    // @ts-expect-error a bare user id is not an actor
    const fromString: AccessActor = 'user-1';
    // @ts-expect-error an object literal lacks the brand only the constructors give
    const fromLiteral: AccessActor = { via: 'credential', userId: 'user-1', authentication: null };
    expect([fromString, fromLiteral]).toHaveLength(2);
  });

  it('an actor without a user or an automation without a reason is refused at construction', () => {
    expect(() => credentialActor('', passkey)).toThrow();
    expect(() => automationActor('user-1', '', inDrives())).toThrow();
    expect(() => automationActor('', 'workflow', inDrives('drive-1'))).toThrow('An access actor needs a user');
  });

  it('a credential derived from an actor carries the credential\'s evidence; an automation signed nothing in', () => {
    expect(derivedCredentialEvidence(credentialActor('user-1', passkey))).toEqual(passkey);
    expect(derivedCredentialEvidence(credentialActor('user-1', null))).toBeNull();
    expect(derivedCredentialEvidence(automationActor('user-1', 'workflow', inDrives('drive-1')))).toBeNull();
  });
});

describe('the actor sign-in decision', () => {
  it('SEC-2 (partial) a drive no org governs admits every actor, evidence or not', () => {
    expect(decideActorAuthentication({ driveId: 'drive-1', actor: credentialActor('u', null), policy: null, nowMs })).toEqual({ allowed: true });
  });

  it('SEC-2 (partial) a single-factor credential is refused an org requiring strong sign-in, with the code', () => {
    expect(decideActorAuthentication({ driveId: 'drive-1', actor: credentialActor('u', magicLink), policy: strongSignIn, nowMs }))
      .toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
  });

  it('SEC-2 (partial) a user-verified passkey credential for the same user is admitted', () => {
    expect(decideActorAuthentication({ driveId: 'drive-1', actor: credentialActor('u', passkey), policy: strongSignIn, nowMs })).toEqual({ allowed: true });
  });

  it('SEC-3 (partial) a credential older than the maximum age is refused with the reauthentication code', () => {
    const stale = { ...magicLink, authenticatedAtMs: nowMs - 61 * 60_000 };
    expect(decideActorAuthentication({ driveId: 'drive-1', actor: credentialActor('u', stale), policy: maxAgeHour, nowMs }))
      .toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });

  it('SEC-2 (partial) SEC-3 (partial) an automation is not a sign-in: sign-in policy never applies inside its own drive', () => {
    const both: OrgAuthenticationPolicy = { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 };
    expect(decideActorAuthentication({ driveId: 'drive-1', actor: automationActor('u', 'workflow', inDrives('drive-1')), policy: both, nowMs })).toEqual({ allowed: true });
  });

  it('SEC-2 (partial) SEC-3 (partial) an automation is confined to its scope: any other drive is refused, policy or not (D-OW-62)', () => {
    const workflow = automationActor('u', 'workflow', inDrives('drive-1'));
    expect(decideActorAuthentication({ driveId: 'drive-2', actor: workflow, policy: null, nowMs })).toEqual({ allowed: false, code: 'automation_out_of_scope' });
    expect(decideActorAuthentication({ driveId: 'drive-2', actor: automationActor('u', 'nothing', inDrives()), policy: null, nowMs }).allowed).toBe(false);
    expect(decideActorAuthentication({ driveId: 'drive-2', actor: automationActor('u', 'pulse', HELD_DRIVES), policy: strongSignIn, nowMs })).toEqual({ allowed: true });
  });
});

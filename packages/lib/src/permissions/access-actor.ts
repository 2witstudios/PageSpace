import type { VerifiedAuthentication } from '../auth/authentication-evidence';
import {
  decideOrgAuthentication,
  type OrgAuthenticationDecision,
  type OrgAuthenticationPolicy,
} from '../organizations/authentication-policy-core';

/**
 * WHO is asking for content, and HOW they got here (D-OW-45). Every access question the permission
 * layer answers about "the caller" takes one of these, never a bare user id, so no path can resolve
 * org content without the org's sign-in policy (SEC-2/SEC-3) having been asked.
 *
 * - `credential`: a person presenting a credential (session, device, MCP or OAuth token, or a worker
 *   dispatched by one). `authentication` is the ceremony evidence bound to that credential; null when
 *   it carries none, which every sign-in policy refuses.
 * - `automation`: work running as its creator with no one signing in (D-OW-34: workflows, triggers,
 *   cron). Sign-in policy does not apply to it; membership and every other policy still do.
 */
export type AccessActor = (
  | {
      readonly via: 'credential';
      readonly userId: string;
      readonly authentication: VerifiedAuthentication | null;
    }
  | {
      readonly via: 'automation';
      readonly userId: string;
      readonly reason: string;
    }
) & AccessActorBrand;

/**
 * Opaque: only credentialActor / automationActor can produce one, so neither a plain string nor a hand-written object
 * literal type-checks as an actor (an `any` still can; the guard test pins the request-body shapes that feed it).
 */
declare const accessActorBrand: unique symbol;
type AccessActorBrand = { readonly [accessActorBrand]: true };

export function credentialActor(
  userId: string,
  authentication: VerifiedAuthentication | null | undefined,
): AccessActor {
  if (!userId) throw new Error('An access actor needs a user');
  return Object.freeze({ via: 'credential', userId, authentication: authentication ?? null }) as AccessActor;
}

export function automationActor(userId: string, reason: string): AccessActor {
  if (!userId) throw new Error('An access actor needs a user');
  if (!reason) throw new Error('An automation actor must name why it runs');
  return Object.freeze({ via: 'automation', userId, reason }) as AccessActor;
}

/**
 * The ceremony evidence a credential DERIVED from this actor carries (a service token minted for the processor):
 * the actor's own for a credential, none for an automation, which signed nothing in.
 */
export function derivedCredentialEvidence(actor: AccessActor): VerifiedAuthentication | null {
  return actor.via === 'credential' ? actor.authentication : null;
}

export type OrgAuthenticationDenialCode = Extract<OrgAuthenticationDecision, { allowed: false }>['code'];

/**
 * The org sign-in decision for this actor on a drive: `policy` is the governing org's policy, null for
 * a drive no org governs (a personal drive). Pure.
 */
export function decideActorAuthentication(input: {
  readonly actor: AccessActor;
  readonly policy: OrgAuthenticationPolicy | null;
  readonly nowMs: number;
}): OrgAuthenticationDecision {
  const { actor, policy, nowMs } = input;
  if (policy === null || actor.via === 'automation') return { allowed: true };
  return decideOrgAuthentication({ policy, authentication: actor.authentication, nowMs });
}

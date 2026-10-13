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
 *   cron). Sign-in policy does not apply to it — and so it is CONFINED (D-OW-62): it reaches only the drives
 *   its `scope` names (the drive the automation lives in), never a drive its creator could open only by
 *   signing in. Membership and every other policy still apply inside that scope.
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
      readonly scope: AutomationScope;
    }
) & AccessActorBrand;

/**
 * What an automation may reach (D-OW-62):
 * - `drives`: exactly these drives (the workflow's, the trigger's, the schedule's) — and nothing else, so an
 *   automation is never a way around an org's sign-in rules for its creator.
 * - `held-drives`: every drive its creator holds. Only for system work whose OUTPUT is filtered per reader by the
 *   org sign-in policy of every org it drew from (Pulse, memory discovery) or that returns names only (the locked
 *   drive listing). The guard test pins each use.
 */
export type AutomationScope =
  | { readonly kind: 'drives'; readonly driveIds: readonly string[] }
  | { readonly kind: 'held-drives' };

/** An automation confined to the drives it lives in (an empty list reaches no drive). */
export function inDrives(...driveIds: string[]): AutomationScope {
  return Object.freeze({ kind: 'drives', driveIds: Object.freeze([...driveIds]) });
}

export const HELD_DRIVES: AutomationScope = Object.freeze({ kind: 'held-drives' });

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

export function automationActor(userId: string, reason: string, scope: AutomationScope): AccessActor {
  if (!userId) throw new Error('An access actor needs a user');
  if (!reason) throw new Error('An automation actor must name why it runs');
  return Object.freeze({ via: 'automation', userId, reason, scope }) as AccessActor;
}

/**
 * The ceremony evidence a credential DERIVED from this actor carries (a service token minted for the processor):
 * the actor's own for a credential, none for an automation, which signed nothing in.
 */
export function derivedCredentialEvidence(actor: AccessActor): VerifiedAuthentication | null {
  return actor.via === 'credential' ? actor.authentication : null;
}

export type OrgAuthenticationDenialCode = Extract<OrgAuthenticationDecision, { allowed: false }>['code'];

/** An automation reaching outside its scope: refused like having no access, and never a sign-in code. */
export const AUTOMATION_OUT_OF_SCOPE = 'automation_out_of_scope' as const;

export type ActorGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: OrgAuthenticationDenialCode | typeof AUTOMATION_OUT_OF_SCOPE };

/** Whether an automation's scope reaches `driveId`. Pure. */
export function automationReaches(scope: AutomationScope, driveId: string): boolean {
  return scope.kind === 'held-drives' || scope.driveIds.includes(driveId);
}

/**
 * The gate every actor-taking access function asks first, for one drive: a credential against the governing org's
 * sign-in policy (`policy`, null for a drive no org governs), an automation against its scope. Pure.
 */
export function decideActorAuthentication(input: {
  readonly actor: AccessActor;
  readonly driveId: string;
  readonly policy: OrgAuthenticationPolicy | null;
  readonly nowMs: number;
}): ActorGateDecision {
  const { actor, driveId, policy, nowMs } = input;
  if (actor.via === 'automation') {
    return automationReaches(actor.scope, driveId) ? { allowed: true } : { allowed: false, code: AUTOMATION_OUT_OF_SCOPE };
  }
  if (policy === null) return { allowed: true };
  return decideOrgAuthentication({ policy, authentication: actor.authentication, nowMs });
}

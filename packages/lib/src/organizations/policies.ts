/**
 * The org policy store and its ONE reader (Spec POL-1). IO only: what a policy may hold and what a
 * change forbids are decided in policies-core.ts.
 *
 * No route reads the organizations row for policy (seam: policy-reads.seam.test.ts). Callers ask
 * getOrgPolicies at the moment of the decision, every time: there is deliberately no module-level cache,
 * so a change applies immediately and in every process (Spec POL-1, leaf E3 "no restart").
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { organizations, orgMembers, type SuspensionKind } from '@pagespace/db/schema/organizations';
import { publishOrgAuditEvents, stageOrgAuditEvents, type OrgAuditEvent } from '../audit/org-audit';
import {
  mergeOrgPolicies,
  newlyBlockedKinds,
  ORG_POLICY_KEYS,
  parseOrgPolicies,
  policyChangeOnlyRestricts,
  suspensionKindsChanged,
  type OrgPolicies,
  type OrgPoliciesPatch,
  type OrgPolicyKey,
} from './policies-core';
import { getOrgPolicies, lockStoredOrgPolicies } from './policy-reader';
import { decideOrgRole } from './authorize-core';
import { retryOnDeadlock } from './repository';
import { applySuspension, type PolicySuspensionItem } from './policy-suspension';
import { listPolicyBlockedItems, type PolicyBlockedItems } from './policy-blocked-items';
import { openDrivesBelowFloor } from './open-role-floor';
import type { OpenRoleFloor } from './policies-core';
import { kickSuspendedGuests } from '../permissions/guest-holds';
import { isOrgActive } from './status';
import { ORG_LAPSED_CODE, ORG_LAPSED_MESSAGE } from './status-core';
import type { VerifiedAuthentication } from '../auth/authentication-evidence';
import {
  decideSignInPolicyChange,
  signInPolicyTightened,
  type OrgAuthenticationDenialCode,
  type OrgAuthenticationPolicy,
} from './authentication-policy-core';
import { countOrgSignInBlocked, type SignInBlockedCounts } from './sign-in-blocked';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export { getOrgPolicies };

export interface PolicyChange {
  key: OrgPolicyKey;
  from: unknown;
  to: unknown;
}

export type UpdateOrgPoliciesResult =
  | {
      ok: true;
      policies: OrgPolicies;
      changes: PolicyChange[];
      suspended: PolicySuspensionItem[];
      restored: PolicySuspensionItem[];
      /** What the change newly forbids that is blocked where it is used rather than suspended (counts, a bounded list). */
      blocked: PolicyBlockedItems;
      /** POL-1 for the sign-in keys: who a tightened sign-in policy now refuses (counts only); null when it did not tighten. */
      signInBlocked: SignInBlockedCounts | null;
    }
  | { ok: false; reason: 'not_found' | 'not_member' | 'insufficient_role' }
  /**
   * SEAT-9 as amended by [D-OW-33]: a LAPSED org may only restrict (billing never blocks security). A change that
   * loosens any policy is refused whole and nothing is stored until the org pays.
   */
  | { ok: false; reason: typeof ORG_LAPSED_CODE; message: string }
  /**
   * POL-6: raising the Open-drive role floor while some Open drive's default role is below it would leave those
   * drives' members under the floor; refused, nothing stored, and the drives named (bounded) so they can be fixed.
   */
  | { ok: false; reason: 'open_role_floor'; floor: OpenRoleFloor; drives: Array<{ id: string; name: string }> }
  /**
   * D-OW-45: loosening a sign-in policy needs the acting credential to satisfy the policy in force (judged under the
   * org row's lock, against the stored value). Nothing is stored; the code says which ceremony would satisfy it.
   */
  | { ok: false; reason: OrgAuthenticationDenialCode }
  /**
   * D-OW-47: tightening it needs the acting credential to satisfy the RESULTING policy, or the Admin would lock
   * themselves out of the org's admin routes. Nothing is stored; `requires` names the ceremony that would.
   */
  | { ok: false; reason: 'org_policy_would_lock_out_actor'; requires: OrgAuthenticationDenialCode };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const signInPolicy = (p: OrgPolicies): OrgAuthenticationPolicy => ({
  requireStrongSignIn: p.requireStrongSignIn,
  maximumSessionAgeMinutes: p.maximumSessionAgeMinutes,
});

/** Ids listed inline on an audit row; the full set is always available from the list endpoint. */
export const AUDIT_LISTED_IDS = 200;

function countsByKind(items: readonly PolicySuspensionItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
}

const listed = (items: ReadonlyArray<{ kind: string; resourceType: string; id: string; driveId: string | null }>) =>
  items.slice(0, AUDIT_LISTED_IDS).map((i) => ({ kind: i.kind, type: i.resourceType, id: i.id, driveId: i.driveId }));

/**
 * POL-1 / AUD-1: the events one policy change writes — the change itself (key, old and new value), and what it
 * newly suspended, restored, or forbids without suspending (blocked), each counted in full and listed up to
 * AUDIT_LISTED_IDS. A change that changed nothing writes nothing.
 */
export function policyChangeAuditEvents(input: {
  orgId: string;
  actorId: string;
  changes: readonly PolicyChange[];
  suspended: readonly PolicySuspensionItem[];
  restored: readonly PolicySuspensionItem[];
  blocked: PolicyBlockedItems;
  /** Who a tightened sign-in policy now refuses (counts only, no identities); null or absent when it did not tighten. */
  signInBlocked?: SignInBlockedCounts | null;
}): OrgAuditEvent[] {
  const { orgId, actorId, changes, suspended, restored, blocked } = input;
  const signInBlocked = input.signInBlocked ?? null;
  if (changes.length === 0) return [];
  const base = { orgId, actorId, resourceType: 'organization', resourceId: orgId } as const;
  const events: OrgAuditEvent[] = [{ ...base, eventType: 'org.policy.changed', details: { changes: changes.map((c) => ({ key: c.key, from: c.from, to: c.to })) } }];
  for (const [eventType, items] of [['org.policy.suspended', suspended], ['org.policy.restored', restored]] as const) {
    if (items.length === 0) continue;
    events.push({ ...base, eventType, details: { counts: countsByKind(items), total: items.length, listed: listed(items), truncated: items.length > AUDIT_LISTED_IDS } });
  }
  if (blocked.total > 0 || (signInBlocked && (signInBlocked.members > 0 || signInBlocked.credentials > 0))) {
    events.push({
      ...base,
      eventType: 'org.policy.blocked',
      details: {
        counts: blocked.counts,
        total: blocked.total,
        listed: listed(blocked.items),
        truncated: blocked.items.length < blocked.total || blocked.items.length > AUDIT_LISTED_IDS,
        ...(signInBlocked ? { signIn: signInBlocked } : {}),
      },
    });
  }
  return events;
}

/**
 * Apply a validated patch. While the org is lapsed only a change that restricts applies ([D-OW-33]). The row lock, the stored policies and every suspension or restore commit in
 * ONE transaction, so there is no moment where the policy says off and an existing link is still live
 * for lack of a marker. Its audit events are staged in that same transaction (AUD-1) and published after commit.
 */
export async function updateOrgPolicies(input: {
  orgId: string;
  actorId: string;
  /** The acting credential's server-verified evidence (D-OW-45): required, so a caller cannot forget it. */
  actorAuthentication: VerifiedAuthentication | null;
  patch: OrgPoliciesPatch;
}): Promise<UpdateOrgPoliciesResult> {
  const { orgId, actorId, actorAuthentication, patch } = input;
  // A policy change can be chosen as a deadlock victim by a concurrent multi-step write (re-verify N6); it rolls back
  // whole, so it is simply run again.
  const done = await retryOnDeadlock(() => db.transaction(async (tx) => {
    const row = await lockStoredOrgPolicies(tx, orgId);
    if (!row) return null;
    // All authority mutations lock org before membership, so a stale route preflight cannot authorize this write.
    const [membership] = await tx.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, actorId))).for('update');
    const authority = decideOrgRole({ membershipRole: membership?.role ?? null, minRole: 'ADMIN' });
    if (!authority.ok) return { authorityRefusal: authority.reason };
    const before = parseOrgPolicies(row.stored);
    const stored = mergeOrgPolicies(row.stored, patch);
    const after = parseOrgPolicies(stored);
    // [D-OW-33] read under the org row's lock, so the change judged is the one stored.
    if (!policyChangeOnlyRestricts(before, after) && !(await isOrgActive(orgId, { executor: tx }))) return { lapsed: true as const };
    const signIn = decideSignInPolicyChange({
      before: signInPolicy(before), after: signInPolicy(after), authentication: actorAuthentication, nowMs: Date.now(),
    });
    if (!signIn.allowed) return { lapsed: false as const, refused: false as const, signInRefused: signIn };
    if (after.openDriveRoleFloor !== before.openDriveRoleFloor) {
      const below = await openDrivesBelowFloor(tx, orgId, after.openDriveRoleFloor);
      if (below.length > 0) return { lapsed: false as const, refused: true as const, signInRefused: null, floor: after.openDriveRoleFloor, drives: below };
    }
    const kinds = suspensionKindsChanged(before, after);
    const outcome = await applySuspension(tx, orgId, after, kinds);
    // Read in the same snapshot as the change: the existing items a newly forbidden, non-suspendable kind reaches.
    const blocked = await listPolicyBlockedItems(tx, orgId, after, newlyBlockedKinds(before, after), AUDIT_LISTED_IDS);
    const signInBlocked = signInPolicyTightened(signInPolicy(before), signInPolicy(after))
      ? await countOrgSignInBlocked(tx, orgId, signInPolicy(after))
      : null;
    await tx.update(organizations).set({ policies: stored }).where(eq(organizations.id, orgId));
    const changes: PolicyChange[] = ORG_POLICY_KEYS.filter((k) => !same(before[k], after[k])).map((key) => ({ key, from: before[key], to: after[key] }));
    // AUD-1: the change's events commit with it (the outbox), listing what it suspended, restored and blocked —
    // and, for the sign-in keys (POL-1), who a tightened sign-in policy now refuses, by count.
    const staged = await stageOrgAuditEvents(tx, policyChangeAuditEvents({ orgId, actorId, changes, suspended: outcome.suspended, restored: outcome.restored, blocked, signInBlocked }));
    return { lapsed: false as const, refused: false as const, signInRefused: null, after, changes, outcome, blocked, signInBlocked, staged };
  }));
  if (!done) return { ok: false, reason: 'not_found' };
  if (done.authorityRefusal) return { ok: false, reason: done.authorityRefusal };
  if (done.lapsed) return { ok: false, reason: ORG_LAPSED_CODE, message: ORG_LAPSED_MESSAGE };
  if (done.signInRefused) {
    const refusal = done.signInRefused;
    return refusal.code === 'org_policy_would_lock_out_actor'
      ? { ok: false, reason: refusal.code, requires: refusal.requires }
      : { ok: false, reason: refusal.code };
  }
  if (done.refused) return { ok: false, reason: 'open_role_floor', floor: done.floor, drives: done.drives };

  const { after, changes, outcome, blocked, signInBlocked, staged } = done;
  // Realtime: a parked guest must stop receiving events in the drive's rooms now, not at their next reconnect.
  // Best effort and never throws; the per-event permission recheck is the enforcement either way.
  await kickSuspendedGuests(
    outcome.suspended.filter((i) => i.kind === 'guests' && i.userId).map((i) => ({ holdId: i.id, driveId: i.driveId, userId: i.userId ?? null, email: null, origin: 'invite' as const, createdAt: new Date() })),
  );
  await publishOrgAuditEvents(staged);
  return { ok: true, policies: after, changes, suspended: outcome.suspended, restored: outcome.restored, blocked, signInBlocked };
}

export type { SuspensionKind };

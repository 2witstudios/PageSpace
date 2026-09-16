/**
 * `isScopeNarrowing` — whether a rebind's next `PlaneScope` authorizes nothing
 * the stored scope does not (ADR 0005 §2.6; G1c R13). A narrowing rebind needs
 * no owner consent: a `policyVersion` bump caused by someone who is not a
 * consenter (an admin removing the owner's membership, the owner deleted, an
 * instructions edit) must still reach the plane, or every outstanding grant
 * stays `bindings_stale` forever. Anything that is not provably narrower —
 * including a lateral change such as another provider or approver — is
 * treated as a widening and needs consent.
 *
 * Narrower-or-equal means, field by field:
 *   - `allowedOrigins`, `auxiliaryOrigins`, `boundAgentPageIds`: subsets;
 *   - `resourceRestrictions`: every stored key survives with a subset of its
 *     values (a new key only restricts more);
 *   - `sessionHttpEnabled`: not turned on;
 *   - `providerSlug`: unchanged (another catalogue can reclassify operations);
 *   - `approvalPolicy`: next is null (every use asks), or both are non-null
 *     and next has subset origins, operations each covered by a stored one,
 *     resource pairs that restrict at least as much, a trigger that asks for
 *     at least as many classes, an end no later (a stored open end admits any
 *     end), limits no higher, and the same approver.
 *
 * Order-independent over every list. Pure.
 */
import type { AccountApprovalPolicy, ApprovalTrigger } from '../../approval';
import type { OperationRef } from '../../grant';
import type { IsScopeNarrowing } from './store-adapter';

/** How many operation classes a trigger still asks for: more asks is narrower. */
const TRIGGER_STRICTNESS: Readonly<Record<ApprovalTrigger, number>> = {
  every_use: 2,
  unknown_and_irreversible: 1,
  irreversible_only: 0,
};

function subset<T>(next: readonly T[], stored: readonly T[]): boolean {
  return next.every((item) => stored.includes(item));
}

/** Every key `stored` restricts, `next` restricts too, to a subset of the values. */
function restrictsAtLeast(next: Readonly<Record<string, readonly string[]>>, stored: Readonly<Record<string, readonly string[]>>): boolean {
  return Object.keys(stored).every((key) => Object.hasOwn(next, key) && subset(next[key]!, stored[key]!));
}

function pairsByKey(pairs: readonly (readonly [string, string])[]): Readonly<Record<string, readonly string[]>> {
  const grouped: Record<string, string[]> = {};
  for (const [key, value] of pairs) (grouped[key] ??= []).push(value);
  return grouped;
}

function operationCovered(operation: OperationRef, stored: readonly OperationRef[]): boolean {
  return stored.some((allowed) => allowed.class === operation.class && (allowed.name === operation.name || (allowed.name === '*' && operation.class !== 'unknown')));
}

function policyNarrowing(next: AccountApprovalPolicy | null, stored: AccountApprovalPolicy | null): boolean {
  if (next === null) return true;
  if (stored === null) return false;
  if (!subset(next.scope.origins, stored.scope.origins)) return false;
  if (!next.scope.operations.every((operation) => operationCovered(operation, stored.scope.operations))) return false;
  if (!restrictsAtLeast(pairsByKey(next.scope.resources), pairsByKey(stored.scope.resources))) return false;
  if (TRIGGER_STRICTNESS[next.trigger] < TRIGGER_STRICTNESS[stored.trigger]) return false;
  if (stored.duration !== null && (next.duration === null || next.duration.until > stored.duration.until)) return false;
  if (next.limits.maxUsesPerHour > stored.limits.maxUsesPerHour) return false;
  if (next.limits.maxBytesOut > stored.limits.maxBytesOut) return false;
  if (next.limits.maxConcurrent > stored.limits.maxConcurrent) return false;
  return next.approver === stored.approver;
}

export const isScopeNarrowing: IsScopeNarrowing = ({ stored, next }) =>
  subset(next.allowedOrigins, stored.allowedOrigins) &&
  subset(next.auxiliaryOrigins, stored.auxiliaryOrigins) &&
  subset(next.boundAgentPageIds, stored.boundAgentPageIds) &&
  restrictsAtLeast(next.resourceRestrictions, stored.resourceRestrictions) &&
  (!next.sessionHttpEnabled || stored.sessionHttpEnabled) &&
  next.providerSlug === stored.providerSlug &&
  policyNarrowing(next.approvalPolicy, stored.approvalPolicy);

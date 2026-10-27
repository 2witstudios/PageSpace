/**
 * `isPlaneScopeWellFormed` — whether every value the plane compares in a
 * `PlaneScope` has its declared shape (ADR 0005 §2.6; G1c review of PR #2660).
 *
 * The scope reaches the plane from the authority, which read it from the main
 * DB — untrusted (H1). Types are erased at runtime, and JavaScript comparisons
 * against a non-number are all false: `"x" > 10` and `"x" < 10` both fail. So a
 * policy with `limits.maxUsesPerHour: "x"` passed `isScopeNarrowing` (no limit
 * was "higher") and then never exceeded its limit in `decideApproval`; an
 * unknown trigger or a non-numeric deadline did the same. A malformed scope is
 * never pinned, never rebound to, and never counts as narrowing.
 *
 * Limits are finite non-negative integers, a deadline is a finite number, the
 * trigger and operation classes come from their closed unions. Pure.
 */
import type { ApprovalTrigger } from '../approval';
import type { OperationClass } from '../grant';
import type { PlaneScope } from './store-adapter';

const TRIGGERS: Readonly<Record<ApprovalTrigger, true>> = { every_use: true, unknown_and_irreversible: true, irreversible_only: true };
const CLASSES: Readonly<Record<OperationClass, true>> = { read: true, write: true, irreversible: true, privilege: true, unknown: true };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPolicyWellFormed(policy: unknown): boolean {
  if (policy === null) return true;
  if (!isObject(policy)) return false;
  const { scope, trigger, duration, limits, approver } = policy;
  if (!isObject(scope) || !isStringArray(scope.origins)) return false;
  if (!Array.isArray(scope.operations) || !scope.operations.every((op) => isObject(op) && typeof op.class === 'string' && Object.prototype.hasOwnProperty.call(CLASSES, op.class) && typeof op.name === 'string')) {
    return false;
  }
  if (!Array.isArray(scope.resources) || !scope.resources.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string')) {
    return false;
  }
  if (typeof trigger !== 'string' || !Object.prototype.hasOwnProperty.call(TRIGGERS, trigger)) return false;
  if (duration !== null && !(isObject(duration) && typeof duration.until === 'number' && Number.isFinite(duration.until))) return false;
  if (!isObject(limits) || !isCount(limits.maxUsesPerHour) || !isCount(limits.maxBytesOut) || !isCount(limits.maxConcurrent)) return false;
  return typeof approver === 'string';
}

export function isPlaneScopeWellFormed({ scope }: { readonly scope: PlaneScope }): boolean {
  const candidate: unknown = scope;
  if (!isObject(candidate)) return false;
  const { resourceRestrictions } = candidate;
  if (!isObject(resourceRestrictions) || !Object.values(resourceRestrictions).every(isStringArray)) return false;
  if (!isStringArray(candidate.boundAgentPageIds) || !isStringArray(candidate.allowedOrigins) || !isStringArray(candidate.auxiliaryOrigins)) return false;
  if (typeof candidate.sessionHttpEnabled !== 'boolean') return false;
  if (candidate.providerSlug !== null && typeof candidate.providerSlug !== 'string') return false;
  return isPolicyWellFormed(candidate.approvalPolicy);
}

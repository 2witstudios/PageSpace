/**
 * `decideApproval` — what the authority must OBTAIN before it issues a grant
 * (ADR 0004 §3.4, §4.3, §8.17, §8.22).
 *
 * Three answers. `policy`: a bounded always-allow covers this exact request
 * — origin in scope, operation named (a `*` name covers only `read`/`write`;
 * `unknown` must be named exactly), every resource key the policy restricts
 * present in the request with an allowed value, the policy unexpired, the
 * trigger not asking for this class, the limits not reached. `concrete`: a
 * human decision bound to this digest, with step-up for `privilege`. This is
 * also the answer whenever the policy simply does not speak to the request
 * (no policy, another operation, expired) — the human is asked, nothing is
 * refused. `refuse`: the policy DOES speak to the request and says no —
 * wrong origin or resource (`out_of_scope`), limits reached
 * (`limits_exceeded`) — or a policy row claims what a policy can never claim,
 * an `irreversible`/`privilege` operation (`class_never_always`: a tampered
 * row broadens nothing, ADR threat model A9).
 *
 * "Ask on write" is decided by the typed class, never by HTTP method. Pure.
 */
import type { AccountApprovalPolicy, ApprovalRequirement, ApprovalTrigger, DecideApproval } from './approval';
import type { OperationClass, OperationRef } from './grant';
import { ALWAYS_ALLOWED_BY_CLASS } from './always-allowed-by-class';

/** Which classes a policy's trigger still ASKS for, even when in scope. */
const ASKS_UNDER_TRIGGER: Readonly<Record<ApprovalTrigger, Readonly<Record<OperationClass, boolean>>>> = {
  every_use: { read: true, write: true, irreversible: true, privilege: true, unknown: true },
  unknown_and_irreversible: { read: false, write: false, irreversible: true, privilege: true, unknown: true },
  irreversible_only: { read: false, write: false, irreversible: true, privilege: true, unknown: false },
};

const concrete = (operation: OperationRef): ApprovalRequirement => ({ kind: 'concrete', stepUp: operation.class === 'privilege' });
const refuse = (reason: Extract<ApprovalRequirement, { kind: 'refuse' }>['reason']): ApprovalRequirement => ({ kind: 'refuse', reason });

/** Does the policy name this operation? A wildcard name never reaches `unknown`. */
function policyNames(operations: AccountApprovalPolicy['scope']['operations'], operation: OperationRef): boolean {
  return operations.some((named) => {
    if (named.class !== operation.class) return false;
    if (named.name === operation.name) return true;
    return named.name === '*' && operation.class !== 'unknown';
  });
}

/** Every resource key the policy restricts must be present in the request with an allowed value. */
function resourcesWithin(scope: AccountApprovalPolicy['scope']['resources'], request: readonly (readonly [string, string])[]): boolean {
  const restrictedKeys = new Set(scope.map(([key]) => key));
  for (const key of restrictedKeys) {
    const requested = request.filter(([requestKey]) => requestKey === key).map(([, value]) => value);
    if (requested.length === 0) return false;
    if (!requested.every((value) => scope.some(([scopeKey, scopeValue]) => scopeKey === key && scopeValue === value))) return false;
  }
  return true;
}

export const decideApproval: DecideApproval = ({ operation, policy, origin, resources, now, usage }) => {
  if (policy === null) return concrete(operation);

  const named = policyNames(policy.scope.operations, operation);
  if (!ALWAYS_ALLOWED_BY_CLASS[operation.class]) return named ? refuse('class_never_always') : concrete(operation);
  if (!named) return concrete(operation);
  if (policy.duration !== null && policy.duration.until <= now) return concrete(operation);

  if (!policy.scope.origins.includes(origin)) return refuse('out_of_scope');
  if (!resourcesWithin(policy.scope.resources, resources)) return refuse('out_of_scope');
  if (ASKS_UNDER_TRIGGER[policy.trigger][operation.class]) return concrete(operation);

  const { limits } = policy;
  if (usage.usesThisHour >= limits.maxUsesPerHour || usage.concurrent >= limits.maxConcurrent || usage.bytesOutThisHour >= limits.maxBytesOut) {
    return refuse('limits_exceeded');
  }
  return { kind: 'policy' };
};

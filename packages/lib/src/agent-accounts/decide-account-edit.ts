/**
 * `decideAccountEdit` — what a human asked an account's permissions to become,
 * as a verdict, before anything touches the plane or the database (slice 2;
 * ADR 0004 §4.3, ADR 0005 §2.6).
 *
 * Two things are editable:
 * - the pinned sites (`allowedOrigins`): the same one-origin rule as creation,
 *   each canonical origin once, sorted, never empty;
 * - "allow without asking" — the bounded standing policy: requests to the
 *   pinned sites that no registry entry describes (`unknown/generic_request`)
 *   run without a per-call approval, up to `maxUsesPerHour`, until `until`
 *   (null = until changed). The trigger still asks for every irreversible or
 *   privileged operation, and the policy's origins are ALWAYS the pinned
 *   sites, so narrowing the sites narrows the policy with them.
 *
 * The approver: a policy keeps its recorded approver when the edit cannot
 * widen it (the caller passes that judgement as `keepApprover`), so an admin
 * lowering a cap does not need the original approver's consent; any other
 * edit records the editor. Pure: the clock is an input.
 */
import type { AccountApprovalPolicy } from './approval';
import type { CanonicalOrigin } from './canonical-request';
import type { UserId } from './grant';
import { normalizeOrigin, type NormalizeOriginVerdict } from './normalize-origin';
import { GENERIC_REQUEST_LIMITS, GENERIC_REQUEST_OPERATION } from './decide-account-creation';

export const MAX_USES_PER_HOUR = 1_000;
/** An end date this soon is a mistake, not a policy. */
const MIN_POLICY_LIFETIME_MS = 5 * 60_000;
const MAX_ALLOWED_ORIGINS = 20;

export type AutoApproveEdit = { readonly enabled: false } | { readonly enabled: true; readonly maxUsesPerHour: number; readonly until: number | null };

export type AccountEdit = {
  readonly allowedOrigins: readonly string[];
  readonly autoApprove: AutoApproveEdit;
};

export type AccountEditRefusal =
  | { readonly ok: false; readonly reason: 'origins_empty' | 'origins_too_many' | 'limit_invalid' | 'until_invalid' }
  | { readonly ok: false; readonly reason: 'origin_invalid'; readonly index: number; readonly rule: Extract<NormalizeOriginVerdict, { readonly ok: false }>['reason'] };

export type AccountEditVerdict =
  | { readonly ok: true; readonly allowedOrigins: readonly CanonicalOrigin[]; readonly approvalPolicy: AccountApprovalPolicy | null }
  | AccountEditRefusal;

/** The editable view of a stored policy, or null when it is not one this editor wrote (every use asks). */
export function autoApproveOf(policy: unknown): (AutoApproveEdit & { readonly enabled: true }) | null {
  if (typeof policy !== 'object' || policy === null) return null;
  const candidate = policy as Partial<AccountApprovalPolicy>;
  const limit = candidate.limits?.maxUsesPerHour;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  const until = candidate.duration === null || candidate.duration === undefined ? null : candidate.duration.until;
  return { enabled: true, maxUsesPerHour: limit, until: typeof until === 'number' ? until : null };
}

export function decideAccountEdit({
  edit,
  editor,
  storedApprover,
  keepApprover,
  now,
}: {
  readonly edit: AccountEdit;
  readonly editor: UserId;
  /** The stored policy's approver, if a policy is stored. */
  readonly storedApprover: UserId | null;
  /** true when the caller established the edit cannot widen the stored policy. */
  readonly keepApprover: boolean;
  readonly now: number;
}): AccountEditVerdict {
  if (!Array.isArray(edit.allowedOrigins) || edit.allowedOrigins.length === 0) return { ok: false, reason: 'origins_empty' };
  if (edit.allowedOrigins.length > MAX_ALLOWED_ORIGINS) return { ok: false, reason: 'origins_too_many' };
  const origins = new Set<CanonicalOrigin>();
  for (let index = 0; index < edit.allowedOrigins.length; index += 1) {
    const verdict = normalizeOrigin({ raw: edit.allowedOrigins[index]! });
    if (!verdict.ok) return { ok: false, reason: 'origin_invalid', index, rule: verdict.reason };
    origins.add(verdict.origin);
  }
  const allowedOrigins = [...origins].sort();

  const { autoApprove } = edit;
  if (autoApprove.enabled !== true) return { ok: true, allowedOrigins, approvalPolicy: null };
  const limit = autoApprove.maxUsesPerHour;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_USES_PER_HOUR) return { ok: false, reason: 'limit_invalid' };
  const until = autoApprove.until;
  if (until !== null && (!Number.isInteger(until) || until < now + MIN_POLICY_LIFETIME_MS)) return { ok: false, reason: 'until_invalid' };

  const approver = keepApprover && storedApprover !== null ? storedApprover : editor;
  return {
    ok: true,
    allowedOrigins,
    approvalPolicy: {
      scope: { origins: allowedOrigins, operations: [{ ...GENERIC_REQUEST_OPERATION }], resources: [] },
      trigger: 'irreversible_only',
      duration: until === null ? null : { until },
      limits: { ...GENERIC_REQUEST_LIMITS, maxUsesPerHour: limit },
      approver,
    },
  };
}

/**
 * `decideAcknowledgment` — whether storing a credential needs the explicit
 * personal-login acknowledgment, and which acknowledgment the reference row
 * records (Λ3; threat model §9; ADR 0005 §4.1 `acknowledgment`).
 *
 * The product story is "make your agent its own account and let the site's
 * own RBAC bound it", so a dedicated account needs nothing. A personal login
 * is stored only when the human said, in so many words, "this is a personal
 * login I share with my agent" — the flag must be exactly `true`; a truthy
 * string or number from a hand-built request is not consent. The rule is the
 * same for every kind in v1; `kind` is an input so a later gate can make the
 * `password`/`session` copy stricter without changing a call site. Pure.
 */
import type { AccountAcknowledgment, AccountKind } from '@pagespace/db/schema/agent-accounts';

/** Whose login this is: a dedicated account made for the agent, or the human's own. */
export type LoginOwnership = 'dedicated' | 'personal';

export type AcknowledgmentVerdict =
  | { readonly ok: true; readonly required: boolean; readonly acknowledgment: AccountAcknowledgment }
  | { readonly ok: false; readonly required: true; readonly reason: 'acknowledgment_required' };

export function decideAcknowledgment({
  ownership,
  acknowledged,
}: {
  readonly kind: AccountKind;
  readonly ownership: LoginOwnership;
  readonly acknowledged: boolean;
}): AcknowledgmentVerdict {
  if (ownership === 'dedicated') return { ok: true, required: false, acknowledgment: 'dedicated_agent_account' };
  if (acknowledged !== true) return { ok: false, required: true, reason: 'acknowledgment_required' };
  return { ok: true, required: true, acknowledgment: 'personal_login_acknowledged' };
}

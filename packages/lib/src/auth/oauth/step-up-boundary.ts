/**
 * The consent step-up boundary (ADR 0004 Decision 6).
 *
 * `POST /api/oauth/authorize` requires a second-factor ceremony for every
 * consent today. That is correct for every grant PageSpace has ever issued —
 * all of them reach content or mint/re-scope a credential — but it is the
 * whole of US8's problem: an app that only wants to know who you are should
 * not drag a passkey or email ceremony into signing in.
 *
 * This module is intended to become the single place that distinction is
 * computed: the screen that decides whether to OFFER the ceremony and the
 * server that decides whether to REQUIRE one must read the same answer from
 * here, because two independent expressions of the rule is exactly how a
 * future scope ends up on a screen that never runs the ceremony — or, worse,
 * on a server that stops demanding one (the drift
 * `isCredentialEscalatingGrant` was written to prevent, one layer down in
 * `./scopes`).
 *
 * It is not that yet, and saying so matters. Production still decides step-up
 * via `isCredentialEscalatingGrant` (`device_authorization/verify/route.ts`,
 * `device_authorization/decision/route.ts`) and via the unconditional step-up
 * on `POST /api/oauth/authorize`. **Phase 1 replaces both with this function**
 * — until it does, the two expressions this module warns about are both live.
 * See ADR 0004 Decision 4, "Phase 1 obligations", item 2.
 *
 * Pure and total: a plain value in, a boolean out, no throw path.
 *
 * @module @pagespace/lib/auth/oauth/step-up-boundary
 */

import type { ScopeSet } from './scopes';

/**
 * Per-field contribution to the step-up decision, one entry per `ScopeSet`
 * field. The `satisfies` clause is the load-bearing part: a new field added to
 * `ScopeSet` fails to compile HERE until someone states, explicitly, whether
 * it can be approved without a second factor. The fail-closed default a
 * reviewer should reach for is `true` — a scope that reaches content, keys, or
 * anything that outlives the consent screen steps up.
 */
const STEP_UP_CONTRIBUTION = {
  /** Any `drive:*` scope is content access. */
  drives: (drives) => drives.size > 0,
  /** Unrestricted content access to every drive the user owns, now and later. */
  allDrives: (allDrives) => allDrives,
  /** The maximum grant: the principal IS the user, everywhere. */
  account: (account) => account,
  /** No content of its own, but it mints and revokes the keys that have it. */
  manageKeys: (manageKeys) => manageKeys,
  /** Re-scopes an existing key in place — a credential change. */
  updateKeyId: (updateKeyId) => updateKeyId !== null,
  /** Makes an existing key a device's ambient default — a credential change. */
  activateKeyId: (activateKeyId) => activateKeyId !== null,
  /**
   * Identity only: name, email, avatar — the fields `/api/auth/me` already
   * returns. Nothing to escalate, nothing that outlives a revoke. This is the
   * ONLY `false` that is a decision rather than a consequence.
   */
  profile: () => false,
  /**
   * Carries no access of its own; it only makes whatever else is in the set
   * refreshable, and that something else is what steps up (`profile
   * offline_access` stays plain, `account offline_access` does not).
   */
  offlineAccess: () => false,
  /**
   * Names the key a mint-shaped grant creates. The mint itself is the
   * escalation, and it is already caught by `drives`/`allDrives` above —
   * parse-time rules make `name:*` unrepresentable without one of them.
   */
  newKeyName: () => false,
} satisfies { readonly [K in keyof ScopeSet]: (value: ScopeSet[K]) => boolean };

/**
 * True iff approving this grant requires the consent step-up ceremony —
 * i.e. iff it grants content access (`drive:*`, `all_drives`, `account`) or
 * touches key material (`manage_keys`, `update_key:*`, `activate_key:*`).
 *
 * False only for identity-alone grants: `profile` and `profile
 * offline_access`.
 *
 * The body is DERIVED from the table rather than enumerating it. That is the
 * half of the guarantee the `satisfies` clause cannot give on its own: the
 * clause closes the table, but a hand-written body that calls each entry can
 * silently omit one, and a new scope would then compile, carry a table entry,
 * and never step up — the fail-open direction (PR #2612 review). With the body
 * derived, adding a `ScopeSet` field is a compile error until the table
 * answers for it, and the answer is then honoured automatically.
 */
export function requiresStepUp(scopes: ScopeSet): boolean {
  return (Object.keys(STEP_UP_CONTRIBUTION) as Array<keyof ScopeSet>).some((field) =>
    (STEP_UP_CONTRIBUTION[field] as (value: ScopeSet[typeof field]) => boolean)(scopes[field]),
  );
}

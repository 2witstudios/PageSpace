/**
 * The consent step-up boundary (ADR 0004 Decision 6).
 *
 * `POST /api/oauth/authorize` requires a second-factor ceremony for every
 * consent today. That is correct for every grant PageSpace has ever issued —
 * all of them reach content or mint/re-scope a credential — but it is the
 * whole of US8's problem: an app that only wants to know who you are should
 * not drag a passkey or email ceremony into signing in.
 *
 * This module is the single place that distinction is computed. The screen
 * that decides whether to OFFER the ceremony and the server that decides
 * whether to REQUIRE one must read the same answer from here; two independent
 * expressions of the rule is exactly how a future scope ends up on a screen
 * that never runs the ceremony — or, worse, on a server that stops demanding
 * one (the drift `isCredentialEscalatingGrant` was written to prevent, one
 * layer down in `./scopes`).
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
 * offline_access`. Every field is listed below so that dropping one is a
 * visible deletion rather than an invisible omission.
 */
export function requiresStepUp(scopes: ScopeSet): boolean {
  return (
    STEP_UP_CONTRIBUTION.drives(scopes.drives) ||
    STEP_UP_CONTRIBUTION.allDrives(scopes.allDrives) ||
    STEP_UP_CONTRIBUTION.account(scopes.account) ||
    STEP_UP_CONTRIBUTION.manageKeys(scopes.manageKeys) ||
    STEP_UP_CONTRIBUTION.updateKeyId(scopes.updateKeyId) ||
    STEP_UP_CONTRIBUTION.activateKeyId(scopes.activateKeyId) ||
    STEP_UP_CONTRIBUTION.profile() ||
    STEP_UP_CONTRIBUTION.offlineAccess() ||
    STEP_UP_CONTRIBUTION.newKeyName()
  );
}

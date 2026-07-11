/**
 * Egress-lockdown application decision (pure).
 *
 * The Sprite network policy lives at `/.sprite/policy/network.json` — a
 * PERSISTENT file on the Sprite's filesystem whose "changes reload live"
 * (docs.sprites.dev/concepts/networking). It therefore survives pause /
 * hibernation and does NOT need re-pushing per connection: re-applying an
 * identical policy on every warm hand-back is pure platform chatter on the
 * connect critical path (the terminal re-authorizes every 60s, so it was paying
 * a control-plane round-trip plus a `mkdir` exec on each tick).
 *
 * So the driver applies the lockdown exactly when it is not already known-good:
 *
 *  - **fresh create** — a brand-new Sprite starts with the platform default
 *    (open outbound), so it is always locked down before it is usable. The
 *    caller persists/links the session only AFTER `getOrCreate` resolves, so a
 *    crash between `createSprite` and lockdown leaves no session row pointing at
 *    an unlocked Sprite: the next attempt sees no link and re-provisions (and
 *    the Sprite is destroyed on lockdown failure anyway). That ordering — not
 *    re-application — is what closes the old crash window.
 *  - **hash mismatch** — the desired policy differs from the one last confirmed
 *    applied to this Sprite (e.g. the egress mode or the allowlist changed), so
 *    the new policy is pushed once and the record updated.
 *  - **unknown** — no recorded hash (a session that predates the record, or one
 *    whose write was lost). Fail closed: apply, then record.
 *
 * The hash is over the BUILT `NetworkPolicy`, not the raw options, so two
 * inputs that produce the same rules (e.g. `'GitHub.com'` and `' github.com '`,
 * which sanitize to the same host) do not thrash the policy. It is canonical:
 * rule key order and rule array order do not change it — the platform resolves
 * precedence by specificity, not position, so a reordered-but-identical rule set
 * is the same policy and must not trigger a re-apply.
 */

import { createHash } from 'crypto';
import type { NetworkPolicy, PolicyRule } from '@fly/sprites';
import { buildSpriteNetworkPolicy } from './egress';
import type { SandboxCreateOptions } from './sandbox-options';

/** Canonical, key-order-independent serialization of a single rule. */
function canonicalizeRule(rule: PolicyRule): string {
  const entries = Object.entries(rule as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Pure: a stable fingerprint of a Sprite network policy. Identical rule sets
 * hash identically regardless of key order or rule order; any change to a
 * domain, an action, or the rule set's membership changes the hash.
 */
export function hashPolicy(policy: NetworkPolicy): string {
  const canonical = policy.rules.map(canonicalizeRule).sort().join('\n');
  return createHash('sha3-256').update(canonical).digest('hex');
}

/**
 * Pure: the hash of the policy `options` asks for — the value a caller records
 * once `getOrCreate` has resolved, and passes back as `appliedPolicyHash` on the
 * next hand-back.
 */
export function hashSandboxEgressPolicy(options: SandboxCreateOptions): string {
  return hashPolicy(
    buildSpriteNetworkPolicy({ egressAllowlist: options.egressAllowlist, egressMode: options.egressMode }),
  );
}

export interface ShouldApplyPolicyInput {
  /** True when the Sprite was just created (platform default = open egress). */
  fresh: boolean;
  /** Hash of the policy last confirmed applied to this Sprite; null/undefined = unknown. */
  appliedPolicyHash?: string | null;
  /** Hash of the policy this hand-back wants (see {@link hashSandboxEgressPolicy}). */
  desiredPolicyHash: string;
}

/** Pure: must the deny-default lockdown be (re-)pushed to this Sprite? */
export function shouldApplyPolicy({
  fresh,
  appliedPolicyHash,
  desiredPolicyHash,
}: ShouldApplyPolicyInput): boolean {
  if (fresh) return true;
  if (!appliedPolicyHash) return true;
  return appliedPolicyHash !== desiredPolicyHash;
}

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
 * What the caller records is therefore not "which policy we want" but a
 * LOCKDOWN TOKEN: proof that a specific policy was confirmed applied to a
 * specific Sprite INSTANCE. Both halves are load-bearing:
 *
 *  - the policy hash, so a changed policy (a new egress mode, a widened
 *    allowlist) is detected and pushed;
 *  - the Sprite's instance id, so a Sprite that was DESTROYED and re-created
 *    under the same name never inherits its predecessor's proof. A fresh VM
 *    starts on the platform default (open outbound), and its name tells you
 *    nothing about that; only its identity does.
 *
 * The instance id is what closes the concurrent-recreate race: given a session
 * row whose token describes a now-vanished Sprite, one caller may be mid-create
 * (its replacement Sprite exists, but its lockdown has not landed yet) while a
 * second caller reads that same replacement by name. The second caller sees
 * `fresh === false`, but the recorded token names the DEAD Sprite, so it does
 * not match — and rather than handing back a VM with open egress, it applies the
 * policy itself. (Both callers pushing the same policy is harmless; one of them
 * skipping it is not.)
 *
 * So the lockdown is applied exactly when it is not already proven:
 *
 *  - **fresh create** — a brand-new Sprite starts with the platform default, so
 *    it is always locked down before it is usable. The caller links the session
 *    only AFTER `getOrCreate` resolves, so a crash between `createSprite` and
 *    lockdown leaves no session row pointing at an unlocked Sprite: the next
 *    attempt sees no link and re-provisions (and the Sprite is destroyed on
 *    lockdown failure anyway). That ordering — not re-application — is what
 *    closes the old crash window.
 *  - **token mismatch** — a different policy, or a different Sprite instance.
 *  - **unknown** — no recorded token (a session that predates the record, or one
 *    whose write was lost), or a platform that did not report the Sprite's id at
 *    all. Fail closed: a proof we cannot construct is a proof we do not have.
 *
 * The policy hash is over the BUILT `NetworkPolicy`, not the raw options, so two
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

/** Pure: the hash of the policy `options` asks for. */
export function hashSandboxEgressPolicy(options: SandboxCreateOptions): string {
  return hashPolicy(
    buildSpriteNetworkPolicy({ egressAllowlist: options.egressAllowlist, egressMode: options.egressMode }),
  );
}

/**
 * Pure: proof that `policyHash` was applied to the Sprite INSTANCE `spriteId` —
 * the value recorded on the session row and handed back on the next connect.
 *
 * Returns `undefined` when the platform did not report an instance id: without
 * it the token cannot distinguish this VM from a replacement created under the
 * same name, and an unprovable claim must never be recorded (the caller then
 * treats the lockdown as unproven and re-applies — fail closed, at the cost of
 * one round-trip).
 */
export function egressLockdownToken({
  spriteId,
  policyHash,
}: {
  spriteId: string | undefined;
  policyHash: string;
}): string | undefined {
  return spriteId ? `${spriteId}:${policyHash}` : undefined;
}

export interface ShouldApplyPolicyInput {
  /** True when the Sprite was just created (platform default = open egress). */
  fresh: boolean;
  /** Token recorded when this session's lockdown was last confirmed; null/undefined = unknown. */
  appliedToken?: string | null;
  /** Token this hand-back would record — undefined when the Sprite's identity is unknown. */
  desiredToken: string | undefined;
}

/** Pure: must the deny-default lockdown be (re-)pushed to this Sprite? */
export function shouldApplyPolicy({ fresh, appliedToken, desiredToken }: ShouldApplyPolicyInput): boolean {
  if (fresh) return true;
  if (!desiredToken) return true;
  if (!appliedToken) return true;
  return appliedToken !== desiredToken;
}

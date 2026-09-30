/**
 * Org policies — the pure half (Spec POL-1..POL-11, Vision principle 2 "one policy reader").
 *
 * The stored shape lives in `organizations.policies` (jsonb). This module is the ONLY place that
 * defines what that object may contain, what each key defaults to, and what a change forbids. `policies.ts`
 * does the IO; no route reads the row (seam: policy-reads.seam.test.ts).
 *
 * Two rules keep the store honest:
 *
 * - DEFAULTS PRESERVE TODAY'S BEHAVIOUR. A key that was never set reads as what the product did before
 *   policies existed, so an org changes behaviour only when an Owner or Admin changes a policy.
 * - A PRESENT BUT INVALID VALUE FAILS CLOSED. Only the validated writer stores keys, so an unreadable
 *   value is corruption; it reads as the strictest value for that key rather than as the default,
 *   because "the row is damaged" must never widen access.
 *
 * Seat count, seat auto-add and billing are NOT policies (point-guard ruling): they are billing state
 * with their own columns. The two spend policies here (seat allowance amount, wallet fallback) are POL-7.
 */
import { DEFAULT_SEAT_ALLOWANCE_CENTS, effectiveSpendPolicy, type FallbackRule, type SpendPolicy } from '../billing/wallet-core';

export const GUEST_POLICIES = ['off', 'approve', 'on'] as const;
export type GuestPolicy = (typeof GUEST_POLICIES)[number];

/** Who may perform an org action: only Owner and Admins, or any member. */
export const ACTOR_POLICIES = ['admins', 'members'] as const;
export type ActorPolicy = (typeof ACTOR_POLICIES)[number];

/** POL-6: the least a default role in an Open drive may grant. The drive picks its own default above it. */
export const OPEN_ROLE_FLOORS = ['view', 'edit'] as const;
export type OpenRoleFloor = (typeof OPEN_ROLE_FLOORS)[number];

export const WALLET_FALLBACKS = ['refuse', 'seat_allowance', 'own_credits'] as const satisfies readonly FallbackRule[];

export interface OrgPolicies {
  /** POL-2 guests from outside the org: off, admins approve, on. */
  guests: GuestPolicy;
  /** POL-3 public share links. */
  publicShareLinks: boolean;
  /** POL-4 publishing to the web. */
  publishWeb: boolean;
  /** POL-4 custom domains on published sites. */
  customDomains: boolean;
  /** POL-5 who can invite members to the org. */
  whoCanInvite: ActorPolicy;
  /** POL-5 who can create org drives. */
  whoCanCreateDrives: ActorPolicy;
  /** POL-6 the floor for the default role in Open drives. */
  openDriveRoleFloor: OpenRoleFloor;
  /** POL-7 the per-consumer monthly seat allowance in whole cents. Never unlimited (see wholeCents). */
  seatAllowanceCents: number;
  /** POL-7 what happens when the chosen wallet is empty. */
  walletFallback: FallbackRule;
  /** POL-8 model ids available in org drives; null = every model. */
  modelAllowlist: string[] | null;
  /** POL-8 provider ids available in org drives; null = every provider. */
  providerAllowlist: string[] | null;
  /** POL-9 agents may run without a person present (mentions, triggers, workflows). */
  agentsAutonomous: boolean;
  /** POL-9 agents from other drives may be added to an org drive. */
  crossDriveAgents: boolean;
  /** POL-10 cloud sandbox. */
  cloudSandbox: boolean;
  /** POL-10 persistent environments. */
  persistentEnvironments: boolean;
  /** POL-10 published apps. */
  publishedApps: boolean;
  /** POL-11 integration provider ids a drive may connect; null = every provider. */
  integrationsAllowlist: string[] | null;
}

export type OrgPolicyKey = keyof OrgPolicies;
export type OrgPoliciesPatch = Partial<OrgPolicies>;

// ---------------------------------------------------------------------------
// Field specs: default, strictest, and a validator, once per key
// ---------------------------------------------------------------------------

interface FieldSpec<V> {
  /** What an unset key reads as: today's behaviour. */
  default: V;
  /** What a present-but-invalid key reads as. */
  strictest: V;
  /** Returns the normalized value, or undefined when `raw` is not a valid value for the key. */
  normalize: (raw: unknown) => V | undefined;
}

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (raw: unknown): T | undefined =>
    typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;

const bool = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined);

/** null (no restriction) or a list of non-empty strings, trimmed and de-duplicated. */
const allowlist = (raw: unknown): string[] | null | undefined => {
  if (raw === null) return null;
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) return undefined;
  const cleaned = raw.map((v) => v.trim()).filter((v) => v.length > 0);
  return [...new Set(cleaned)];
};

/**
 * Whole non-negative cents. There is NO unlimited seat allowance: the credit gate already reads a missing
 * allowance as the default (seatAllowanceCents in wallet-core), so accepting null here would only promise
 * an "unlimited" that the gate never delivers. A raise is an explicit number.
 */
const wholeCents = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;

const SPECS: { [K in OrgPolicyKey]: FieldSpec<OrgPolicies[K]> } = {
  // The default keeps org-drive invites working as they do today; a drive admin can already invite anyone.
  guests: { default: 'on', strictest: 'off', normalize: oneOf(GUEST_POLICIES) },
  publicShareLinks: { default: true, strictest: false, normalize: bool },
  publishWeb: { default: true, strictest: false, normalize: bool },
  customDomains: { default: true, strictest: false, normalize: bool },
  whoCanInvite: { default: 'admins', strictest: 'admins', normalize: oneOf(ACTOR_POLICIES) },
  whoCanCreateDrives: { default: 'admins', strictest: 'admins', normalize: oneOf(ACTOR_POLICIES) },
  openDriveRoleFloor: { default: 'view', strictest: 'edit', normalize: oneOf(OPEN_ROLE_FLOORS) },
  seatAllowanceCents: { default: DEFAULT_SEAT_ALLOWANCE_CENTS, strictest: 0, normalize: wholeCents },
  walletFallback: { default: 'refuse', strictest: 'refuse', normalize: oneOf(WALLET_FALLBACKS) },
  // An invalid allowlist reads as EMPTY (nothing allowed), never as null (everything allowed).
  modelAllowlist: { default: null, strictest: [], normalize: allowlist },
  providerAllowlist: { default: null, strictest: [], normalize: allowlist },
  agentsAutonomous: { default: true, strictest: false, normalize: bool },
  crossDriveAgents: { default: true, strictest: false, normalize: bool },
  cloudSandbox: { default: true, strictest: false, normalize: bool },
  persistentEnvironments: { default: true, strictest: false, normalize: bool },
  publishedApps: { default: true, strictest: false, normalize: bool },
  integrationsAllowlist: { default: null, strictest: [], normalize: allowlist },
};

export const ORG_POLICY_KEYS = Object.keys(SPECS) as OrgPolicyKey[];

export const DEFAULT_ORG_POLICIES: Readonly<OrgPolicies> = Object.freeze(
  Object.fromEntries(ORG_POLICY_KEYS.map((k) => [k, SPECS[k].default])) as unknown as OrgPolicies,
);

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw);

function readKey<K extends OrgPolicyKey>(stored: Record<string, unknown>, key: K): OrgPolicies[K] {
  const spec = SPECS[key] as FieldSpec<OrgPolicies[K]>;
  if (!(key in stored) || stored[key] === undefined) return cloneValue(spec.default);
  const value = spec.normalize(stored[key]);
  return value === undefined ? cloneValue(spec.strictest) : value;
}

const cloneValue = <V>(v: V): V => (Array.isArray(v) ? ([...v] as unknown as V) : v);

/** Every policy, with defaults for unset keys and the strictest value for damaged ones. Never throws. */
export function parseOrgPolicies(raw: unknown): OrgPolicies {
  const stored = isRecord(raw) ? raw : {};
  return Object.fromEntries(ORG_POLICY_KEYS.map((k) => [k, readKey(stored, k)])) as unknown as OrgPolicies;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type PolicyPatchValidation =
  | { ok: true; patch: OrgPoliciesPatch }
  | { ok: false; issues: string[] };

/** Strict: unknown keys, invalid values, non-objects and empty patches are refused. */
export function validateOrgPoliciesPatch(input: unknown): PolicyPatchValidation {
  if (!isRecord(input)) return { ok: false, issues: ['body must be an object of policy values'] };
  const issues: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!(ORG_POLICY_KEYS as string[]).includes(key)) {
      issues.push(`unknown policy: ${key}`);
      continue;
    }
    const value = (SPECS[key as OrgPolicyKey].normalize as (r: unknown) => unknown)(raw);
    if (value === undefined) issues.push(`invalid value for ${key}`);
    else patch[key] = value;
  }
  if (issues.length === 0 && Object.keys(patch).length === 0) issues.push('no policies to change');
  return issues.length > 0 ? { ok: false, issues } : { ok: true, patch: patch as OrgPoliciesPatch };
}

/**
 * The object to store: what was stored, with the patched keys written over it. Only explicitly set keys are
 * stored, so a default that changes later still reaches the orgs that never set the key.
 */
export function mergeOrgPolicies(stored: unknown, patch: OrgPoliciesPatch): Record<string, unknown> {
  return { ...(isRecord(stored) ? stored : {}), ...patch };
}

// ---------------------------------------------------------------------------
// Suspension: what a policy set the strict way forbids in EXISTING content (POL-1)
// ---------------------------------------------------------------------------

export const SUSPENSION_KINDS = ['publicShareLinks', 'publishedPages', 'customDomains', 'guests', 'integrations'] as const;
export type SuspensionKind = (typeof SUSPENSION_KINDS)[number];

export interface SuspensionTargets {
  /** Drive and page share links are forbidden. */
  publicShareLinks: boolean;
  /** Published pages are forbidden. */
  publishedPages: boolean;
  /** Custom domains are forbidden. */
  customDomains: boolean;
  /** Guests from outside the org are forbidden. `approve` gates new invites only; it suspends nothing. */
  guests: boolean;
  /** Drive integration connections whose provider is outside `restrictTo` are forbidden; null = no restriction. */
  integrations: { restrictTo: string[] | null };
}

/**
 * What the policies forbid in content that already exists. Pure state, not a diff: applying it is
 * idempotent, which is what makes suspension reversible (turning a policy back on empties the target
 * and the restore step clears the marker on exactly what this suspended).
 */
export function suspensionTargets(policies: OrgPolicies): SuspensionTargets {
  return {
    publicShareLinks: !policies.publicShareLinks,
    publishedPages: !policies.publishWeb,
    customDomains: !policies.customDomains,
    guests: policies.guests === 'off',
    integrations: { restrictTo: policies.integrationsAllowlist === null ? null : [...policies.integrationsAllowlist] },
  };
}

const sameSet = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && a.every((v) => b.includes(v));

/** The kinds whose governing policy differs between two states: the ones whose suspend-or-restore must run. */
export function suspensionKindsChanged(before: OrgPolicies, after: OrgPolicies): SuspensionKind[] {
  const b = suspensionTargets(before);
  const a = suspensionTargets(after);
  const changed: SuspensionKind[] = [];
  if (a.publicShareLinks !== b.publicShareLinks) changed.push('publicShareLinks');
  if (a.publishedPages !== b.publishedPages) changed.push('publishedPages');
  if (a.customDomains !== b.customDomains) changed.push('customDomains');
  if (a.guests !== b.guests) changed.push('guests');
  if (!sameSet(a.integrations.restrictTo, b.integrations.restrictTo)) changed.push('integrations');
  return changed;
}

// ---------------------------------------------------------------------------
// POL-7: what the credit gate reads
// ---------------------------------------------------------------------------

/** The org-level spend policy the credit gate resolves a drive's rule against. */
export function orgPolicySpendPolicy(policies: Pick<OrgPolicies, 'seatAllowanceCents' | 'walletFallback'>): SpendPolicy {
  return { seatAllowanceCents: policies.seatAllowanceCents, fallback: policies.walletFallback };
}

/** A drive may only be stricter than its org (point-guard ruling, effectiveSpendPolicy). */
export function driveSpendPolicy(
  policies: Pick<OrgPolicies, 'seatAllowanceCents' | 'walletFallback'>,
  drive: Partial<SpendPolicy> | null,
): SpendPolicy {
  return effectiveSpendPolicy(orgPolicySpendPolicy(policies), drive);
}

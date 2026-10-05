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
 * The most a seat allowance may be set to: 10,000,000 cents ($100,000 a month per member). A ceiling
 * exists so "a very large number" is not "unlimited by another name": the cap arithmetic multiplies
 * cents into millicents, and an unbounded value would walk toward 2^53 there.
 */
export const MAX_SEAT_ALLOWANCE_CENTS = 10_000_000;

/**
 * Whole non-negative cents, at most MAX_SEAT_ALLOWANCE_CENTS. There is NO unlimited seat allowance: the credit gate already reads a missing
 * allowance as the default (seatAllowanceCents in wallet-core), so accepting null here would only promise
 * an "unlimited" that the gate never delivers. A raise is an explicit number.
 */
const wholeCents = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_SEAT_ALLOWANCE_CENTS ? raw : undefined;

const SPECS: { [K in OrgPolicyKey]: FieldSpec<OrgPolicies[K]> } = {
  // The default keeps org-drive invites working as they do today; a drive admin can already invite anyone.
  guests: { default: 'on', strictest: 'off', normalize: oneOf(GUEST_POLICIES) },
  publicShareLinks: { default: true, strictest: false, normalize: bool },
  publishWeb: { default: true, strictest: false, normalize: bool },
  customDomains: { default: true, strictest: false, normalize: bool },
  whoCanInvite: { default: 'admins', strictest: 'admins', normalize: oneOf(ACTOR_POLICIES) },
  // Every member may create org drives today (DRV-3 without a policy), so that is the default; a damaged value is admins only.
  whoCanCreateDrives: { default: 'members', strictest: 'admins', normalize: oneOf(ACTOR_POLICIES) },
  // A FLOOR is a minimum: a higher floor gives org members MORE in Open drives. So the value that fails closed is the
  // lowest one, view (it adds nothing to what a drive chose), never edit (Review 3+4: `edit` here failed open).
  openDriveRoleFloor: { default: 'view', strictest: 'view', normalize: oneOf(OPEN_ROLE_FLOORS) },
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
// POL-6: the floor under an Open drive's default role
// ---------------------------------------------------------------------------

type FloorGrant = { canView: boolean; canEdit: boolean; canShare: boolean };

/** What a role with no drive-wide grant gives drive-wide: the plain member's view (the resolver's fallback). */
const MEMBER_VIEW: FloorGrant = { canView: true, canEdit: false, canShare: false };

const grantMeetsFloor = (floor: OpenRoleFloor, grant: FloorGrant): boolean => grant.canView && (floor === 'view' || grant.canEdit);

/**
 * POL-6 (D-OW-11): the default role org members hold in an Open drive is the DRIVE's setting (its default custom
 * role); the org policy sets only the floor under it. Does a default role meet `floor` with what it EFFECTIVELY
 * grants? Its drive-wide grant (null: none, which the resolver reads as the plain member's view) and every per-page
 * entry, because a per-page entry wins over the drive-wide grant on its page (Review #2762 P2-4, P3-2). `view`
 * needs view everywhere; `edit` needs view and edit everywhere.
 */
export function openDefaultRoleMeetsFloor(
  floor: OpenRoleFloor,
  driveWide: FloorGrant | null,
  pages: Record<string, FloorGrant> = {},
): boolean {
  return grantMeetsFloor(floor, driveWide ?? MEMBER_VIEW) && Object.values(pages).every((grant) => grantMeetsFloor(floor, grant));
}

export const OPEN_ROLE_FLOOR_MESSAGES: Record<OpenRoleFloor, string> = {
  view: "This organization requires the default role in its drives to let members view the drive. Give the role drive-wide view, or choose another default.",
  edit: "This organization requires the default role in its drives to let members edit the drive. Give the role drive-wide edit, or choose another default.",
};

export const OPEN_ROLE_FLOOR_RAISE_MESSAGE =
  "Some of this organization's Open drives have a default role below that floor. Give each listed drive's default role drive-wide access at the new floor, or make the drive Restricted, then raise it.";

// ---------------------------------------------------------------------------
// Blocked, not suspended: what a change forbids that has no suspension (POL-1)
// ---------------------------------------------------------------------------

/**
 * What a policy can newly forbid that is NOT suspended: these are stopped where they are used (the app and env
 * routes, the agent resolver, the autonomy gates, the model gate), so nothing is parked or marked. A change that
 * forbids them still lists the existing items it affects in the audit log, so an Owner or Admin can see what the
 * change reached (Spec POL-1 "listed in the audit log").
 */
export const BLOCKED_KINDS = ['publishedApps', 'persistentEnvironments', 'crossDriveAgents', 'agentsAutonomous', 'models'] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

/** True when `after` allows less than `before`: something on the old list (null = everything) is not on the new. */
const narrowed = (before: readonly string[] | null, after: readonly string[] | null): boolean =>
  after !== null && (before === null || before.some((v) => !after.includes(v)));

/** The blocked kinds a change from `before` to `after` newly forbids, in BLOCKED_KINDS order. */
export function newlyBlockedKinds(before: OrgPolicies, after: OrgPolicies): BlockedKind[] {
  const turnedOff = (key: 'publishedApps' | 'persistentEnvironments' | 'crossDriveAgents' | 'agentsAutonomous') => before[key] && !after[key];
  const blocked: BlockedKind[] = [];
  if (turnedOff('publishedApps')) blocked.push('publishedApps');
  if (turnedOff('persistentEnvironments')) blocked.push('persistentEnvironments');
  if (turnedOff('crossDriveAgents')) blocked.push('crossDriveAgents');
  if (turnedOff('agentsAutonomous')) blocked.push('agentsAutonomous');
  if (narrowed(before.modelAllowlist, after.modelAllowlist) || narrowed(before.providerAllowlist, after.providerAllowlist)) blocked.push('models');
  return blocked;
}

// ---------------------------------------------------------------------------
// [D-OW-33] restricting vs loosening: what a LAPSED org may still change
// ---------------------------------------------------------------------------

/** Rank of each ordered value, lowest = strictest. */
const GUEST_RANK: Record<GuestPolicy, number> = { off: 0, approve: 1, on: 2 };
const ACTOR_RANK: Record<ActorPolicy, number> = { admins: 0, members: 1 };
// A floor is a minimum grant: a higher floor gives members MORE (see SPECS.openDriveRoleFloor).
const FLOOR_RANK: Record<OpenRoleFloor, number> = { view: 0, edit: 1 };

/** `after` allows nothing `before` did not (null = everything allowed). */
const subsetOf = (after: readonly string[] | null, before: readonly string[] | null): boolean =>
  before === null || (after !== null && after.every((v) => before.includes(v)));

const notLooser = (before: boolean, after: boolean): boolean => before || !after;

/**
 * Per key: does `after` give no more than `before`? One entry per policy, so a new key cannot be added without
 * being classified. Equal values are not looser.
 */
const NO_LOOSER: { [K in OrgPolicyKey]: (before: OrgPolicies[K], after: OrgPolicies[K]) => boolean } = {
  guests: (b, a) => GUEST_RANK[a] <= GUEST_RANK[b],
  publicShareLinks: notLooser,
  publishWeb: notLooser,
  customDomains: notLooser,
  whoCanInvite: (b, a) => ACTOR_RANK[a] <= ACTOR_RANK[b],
  whoCanCreateDrives: (b, a) => ACTOR_RANK[a] <= ACTOR_RANK[b],
  openDriveRoleFloor: (b, a) => FLOOR_RANK[a] <= FLOOR_RANK[b],
  seatAllowanceCents: (b, a) => a <= b,
  // Refuse is the only fallback strictly below the others: seat allowance spends org money, own credits a
  // person's, so neither is a subset of the other and a move between them is not a restriction.
  walletFallback: (b, a) => a === b || a === 'refuse',
  modelAllowlist: (b, a) => subsetOf(a, b),
  providerAllowlist: (b, a) => subsetOf(a, b),
  agentsAutonomous: notLooser,
  crossDriveAgents: notLooser,
  cloudSandbox: notLooser,
  persistentEnvironments: notLooser,
  publishedApps: notLooser,
  integrationsAllowlist: (b, a) => subsetOf(a, b),
};

/** The keys a change from `before` to `after` loosens (grants or spends more), in ORG_POLICY_KEYS order. */
export function loosenedPolicyKeys(before: OrgPolicies, after: OrgPolicies): OrgPolicyKey[] {
  return ORG_POLICY_KEYS.filter((key) => !(NO_LOOSER[key] as (b: unknown, a: unknown) => boolean)(before[key], after[key]));
}

/**
 * [D-OW-33] billing never blocks security: while an org is lapsed, an Owner or Admin may still make a change that
 * only RESTRICTS (turn guests off, tighten sharing, lower the allowance, narrow an allowlist). A change that loosens
 * any key — including a mixed change that also restricts others — stays refused until the org pays (SEAT-9).
 */
export function policyChangeOnlyRestricts(before: OrgPolicies, after: OrgPolicies): boolean {
  return loosenedPolicyKeys(before, after).length === 0;
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

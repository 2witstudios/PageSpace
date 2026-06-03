/**
 * Pure decision logic for the two user-controllable system AI crons — **Pulse**
 * (daily workspace summary) and **Memory** (learns from conversations) — both of
 * which spend prepaid credits automatically. No I/O here: the cron loop and the
 * `/api/settings/automations` route are thin shells that fetch/persist rows and
 * delegate every decision to these functions. Tier and stored rows are passed in.
 */

import type { SubscriptionTier } from '../services/subscription-utils';

/** Tiers for which Memory (conversation learning) is available. */
export const MEMORY_PAYING_TIERS: readonly SubscriptionTier[] = ['pro', 'founder', 'business'];

/** Memory is a paid feature; free users see it locked. */
export function isMemoryAvailable(tier: SubscriptionTier): boolean {
  return MEMORY_PAYING_TIERS.includes(tier);
}

/** A user's stored pulse preference (subset of `userAutomationPreferences`). */
export interface PulsePrefRow {
  pulseEnabled: boolean;
}

/**
 * Pulse is opt-OUT: a missing preference row means enabled. Only an explicit
 * `pulseEnabled=false` turns it off.
 */
export function resolvePulseEnabled(row: PulsePrefRow | null | undefined): boolean {
  return row?.pulseEnabled ?? true;
}

/**
 * Keep only the users still eligible for automatic pulse generation: everyone
 * except those whose preference row explicitly disables it. Users with no row stay
 * (default enabled). Preserves the input order.
 */
export function filterPulseEligible(
  userIds: string[],
  prefRows: Array<{ userId: string; pulseEnabled: boolean }>,
): string[] {
  const disabled = new Set(
    prefRows.filter((r) => r.pulseEnabled === false).map((r) => r.userId),
  );
  return userIds.filter((id) => !disabled.has(id));
}

/** Validated decisions from an automation PATCH, or an error to return verbatim. */
export type AutomationPatchResult =
  | { pulse?: boolean; memory?: boolean }
  | { error: string; status: number };

/**
 * Validate a `PATCH /api/settings/automations` body against the caller's tier.
 * Rejects malformed bodies and enabling Memory on a non-paid tier. Turning either
 * automation OFF is always allowed (even for free tier, even if currently locked).
 */
export function validateAutomationPatch(
  body: unknown,
  tier: SubscriptionTier,
): AutomationPatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body', status: 400 };
  }

  const { pulseEnabled, memoryEnabled } = body as Record<string, unknown>;

  if (pulseEnabled === undefined && memoryEnabled === undefined) {
    return { error: 'At least one of pulseEnabled, memoryEnabled is required', status: 400 };
  }
  if (pulseEnabled !== undefined && typeof pulseEnabled !== 'boolean') {
    return { error: 'pulseEnabled must be a boolean', status: 400 };
  }
  if (memoryEnabled !== undefined && typeof memoryEnabled !== 'boolean') {
    return { error: 'memoryEnabled must be a boolean', status: 400 };
  }
  if (memoryEnabled === true && !isMemoryAvailable(tier)) {
    return { error: 'Memory is available on paid plans only', status: 403 };
  }

  const result: { pulse?: boolean; memory?: boolean } = {};
  if (pulseEnabled !== undefined) result.pulse = pulseEnabled;
  if (memoryEnabled !== undefined) result.memory = memoryEnabled;
  return result;
}

/** The shape returned by `GET /api/settings/automations`. */
export interface AutomationView {
  pulse: { enabled: boolean };
  memory: { enabled: boolean; available: boolean };
}

/**
 * Assemble the automations view from the user's stored rows and tier. Both flags are
 * default-on (opt-out) when their row is absent. `memory.available` reflects the tier
 * gate; `memory.enabled` reflects the stored personalization flag regardless of
 * availability (so a downgraded user's prior setting is preserved and just shown locked).
 */
export function buildAutomationView(
  pulseRow: PulsePrefRow | null | undefined,
  personalization: { enabled: boolean } | null | undefined,
  tier: SubscriptionTier,
): AutomationView {
  return {
    pulse: { enabled: resolvePulseEnabled(pulseRow) },
    memory: {
      enabled: personalization?.enabled ?? true,
      available: isMemoryAvailable(tier),
    },
  };
}

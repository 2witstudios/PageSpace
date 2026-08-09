import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { userAutomationPreferences } from '@pagespace/db/schema/automation-preferences';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  buildAutomationView,
  validateAutomationPatch,
} from '@pagespace/lib/billing/automation-preferences';
import { toSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/** Read the user's tier, pulse preference, and memory (personalization) flag. */
async function loadAutomationState(userId: string) {
  const [userRow, pulseRow, personalization] = await Promise.all([
    db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).limit(1),
    db
      .select({ pulseEnabled: userAutomationPreferences.pulseEnabled })
      .from(userAutomationPreferences)
      .where(eq(userAutomationPreferences.userId, userId))
      .limit(1),
    db
      .select({ enabled: userPersonalization.enabled })
      .from(userPersonalization)
      .where(eq(userPersonalization.userId, userId))
      .limit(1),
  ]);

  const rawTier = userRow[0]?.tier;
  const tier: SubscriptionTier = toSubscriptionTier(rawTier);
  return { tier, pulseRow: pulseRow[0], personalization: personalization[0] };
}

// GET /api/settings/automations — current Pulse + Memory automation state.
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const { tier, pulseRow, personalization } = await loadAutomationState(auth.userId);
    return NextResponse.json(buildAutomationView(pulseRow, personalization, tier));
  } catch (error) {
    loggers.api.error('Error fetching automation settings:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch automation settings' }, { status: 500 });
  }
}

// PATCH /api/settings/automations — toggle Pulse and/or Memory.
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json().catch(() => null);

    // Single read of current state; the response view is then derived from it + the
    // applied decision (no post-write re-read needed — we know exactly what changed).
    const { tier, pulseRow, personalization } = await loadAutomationState(userId);
    const decision = validateAutomationPatch(body, tier);
    if ('error' in decision) {
      return NextResponse.json({ error: decision.error }, { status: decision.status });
    }

    if (decision.pulse !== undefined) {
      await db
        .insert(userAutomationPreferences)
        .values({ userId, pulseEnabled: decision.pulse })
        .onConflictDoUpdate({
          target: userAutomationPreferences.userId,
          set: { pulseEnabled: decision.pulse, updatedAt: new Date() },
        });
    }

    if (decision.memory !== undefined) {
      await db
        .insert(userPersonalization)
        .values({ userId, bio: '', writingStyle: '', rules: '', enabled: decision.memory })
        .onConflictDoUpdate({
          target: userPersonalization.userId,
          set: { enabled: decision.memory, updatedAt: new Date() },
        });
    }

    audit({ eventType: 'admin.settings.changed', userId, resourceType: 'automation_preferences' });

    const updatedPulseRow = decision.pulse !== undefined ? { pulseEnabled: decision.pulse } : pulseRow;
    const updatedPersonalization =
      decision.memory !== undefined ? { enabled: decision.memory } : personalization;
    return NextResponse.json(buildAutomationView(updatedPulseRow, updatedPersonalization, tier));
  } catch (error) {
    loggers.api.error('Error updating automation settings:', error as Error);
    return NextResponse.json({ error: 'Failed to update automation settings' }, { status: 500 });
  }
}

import { db } from '@pagespace/db/db'
import { and, eq, isNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'

/**
 * First-run onboarding completion state.
 *
 * The stored value is `users.onboardingCompletedAt` — a nullable high-water
 * mark, the same shape as `starterSkillsInstalledAt`. A timestamp (rather than a
 * boolean) records WHEN, which is what makes the release backfill legible after
 * the fact: every pre-existing user carries one identical stamp.
 *
 * Read completion through these helpers rather than testing the column for null
 * at call sites. `NULL` alone does not mean "show onboarding" — it means "no
 * completion recorded", which before the backfill runs is also true of every
 * user who predates the feature. See
 * scripts/backfill-onboarding-completed.ts.
 */

/** True once the user has finished or dismissed first-run onboarding. */
export async function hasCompletedOnboarding(userId: string): Promise<boolean> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { onboardingCompletedAt: true },
  });

  // A missing user is reported as completed, not as needing onboarding: the
  // caller is deciding whether to show a modal, and the safe answer for an
  // unresolvable user is to show nothing rather than to onboard a ghost.
  if (!row) return true;

  return row.onboardingCompletedAt !== null;
}

/**
 * Record that the user finished or dismissed onboarding.
 *
 * Idempotent by construction: the `IS NULL` guard means a second call is a
 * no-op rather than moving the timestamp, so the recorded moment is always the
 * FIRST completion. Dismissing counts — a user who skips has decided, and
 * re-showing the flow would override that decision.
 */
export async function markOnboardingComplete(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ onboardingCompletedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt)));
}

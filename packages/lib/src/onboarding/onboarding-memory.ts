import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { userPersonalization } from '@pagespace/db/schema/personalization'
import { getHomeDrive } from '../services/drive-service'
import { provisionMemoryPages } from '../memory/memory-pages'

/**
 * Write what the user told us during first-run onboarding into their About You
 * memory page, so every agent inherits it from their very next turn.
 *
 * This exists because onboarding makes the promise out loud — "it remembers,
 * you never start from scratch twice". Nothing else in the codebase writes
 * About You *content*: `memory-pages.ts` creates the page empty and reads it,
 * and the `personalization_candidates` staging path deliberately requires a
 * claim to recur across distinct days before it is promoted. A one-time
 * onboarding answer would never satisfy that, so staging a candidate would
 * leave the promise false. We write directly, and accept that this is the one
 * sanctioned direct writer.
 *
 * Appends rather than replaces: the page may already hold content (a returning
 * user re-running the flow, or a self-heal that raced us), and onboarding is
 * never entitled to erase what the user or another agent wrote there.
 */

export interface OnboardingContext {
  /** The scale the user chose, in their own words (e.g. "a small business or a tight team"). */
  scaleLabel: string;
  /** What the user typed as their first request. */
  firstRequest: string;
}

/** The heading this writer owns, so a re-run replaces its own block and nothing else. */
const SECTION_HEADING = '## From onboarding';

export async function recordOnboardingContext(
  userId: string,
  context: OnboardingContext,
): Promise<{ written: boolean }> {
  const trimmedRequest = context.firstRequest.trim();
  if (!trimmedRequest) return { written: false };

  const homeDrive = await getHomeDrive(userId);
  if (!homeDrive) return { written: false };

  // Resolve (self-healing) the About You pointer. provisionMemoryPages is
  // idempotent and row-locks the user, so this is safe to call on every run and
  // covers the case where the pointer was never provisioned.
  const { bioPageId } = await db.transaction(async (tx) =>
    provisionMemoryPages(userId, homeDrive.id, tx),
  );
  if (!bioPageId) return { written: false };

  const existing = await db.query.pages.findFirst({
    where: eq(pages.id, bioPageId),
    columns: { content: true },
  });

  const block = [
    SECTION_HEADING,
    '',
    `- Working at this scale: ${context.scaleLabel}`,
    `- What they came here to do: ${trimmedRequest}`,
  ].join('\n');

  const priorRaw = existing?.content ?? '';
  // Strip a previous block written by this same function so re-running
  // onboarding updates its own section instead of stacking duplicates.
  const prior = stripOwnSection(priorRaw).trimEnd();
  const next = prior ? `${prior}\n\n${block}\n` : `${block}\n`;

  await db
    .update(pages)
    .set({ content: next, contentMode: 'markdown' })
    .where(eq(pages.id, bioPageId));

  return { written: true };
}

/**
 * Remove a previously-written "From onboarding" section, up to the next
 * top-or-second-level heading, leaving everything else untouched.
 */
function stripOwnSection(content: string): string {
  const start = content.indexOf(SECTION_HEADING);
  if (start === -1) return content;

  const after = content.slice(start + SECTION_HEADING.length);
  const nextHeading = after.search(/\n#{1,2} /);
  if (nextHeading === -1) return content.slice(0, start);
  return content.slice(0, start) + after.slice(nextHeading + 1);
}

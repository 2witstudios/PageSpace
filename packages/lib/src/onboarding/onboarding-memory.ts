import { db } from '@pagespace/db/db'
import { eq, sql } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
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

/**
 * Exact, unique delimiters marking the block this writer owns.
 *
 * HTML comments, not a markdown heading: matching on a heading like
 * "## From onboarding" also matches user prose such as "## From onboarding
 * notes", an inline mention, or the same words inside a fenced code block — and
 * the strip would then delete everything from that point to the next heading.
 * These markers are invisible in rendered markdown and are not something a user
 * writes by accident.
 */
const BLOCK_START = '<!-- pagespace:onboarding:start -->';
const BLOCK_END = '<!-- pagespace:onboarding:end -->';

/**
 * Strip anything that would read as one of our own markers out of user text.
 *
 * `firstRequest` is whatever the user typed. If they type the end marker — by
 * accident or otherwise — it closes the block early, and the next run's
 * `stripOwnBlock` then removes only up to the injected marker and leaves stale
 * content stranded inside the page. Matched loosely (any spacing, either
 * keyword) so a near-miss cannot slip through.
 */
function neutralizeMarkers(value: string): string {
  return value.replace(/<!--\s*pagespace:onboarding:\w*\s*-->/gi, '');
}

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

  const block = [
    BLOCK_START,
    '',
    '## From onboarding',
    '',
    `- Working at this scale: ${neutralizeMarkers(context.scaleLabel)}`,
    `- What they came here to do: ${neutralizeMarkers(trimmedRequest)}`,
    '',
    BLOCK_END,
  ].join('\n');

  // Read and write inside ONE transaction, with the page row locked. The
  // previous version read the content, rewrote it whole, and updated in a
  // separate statement — so two concurrent completions could both read the same
  // content and the later write would silently discard the earlier one, along
  // with anything the user or another agent had written in between.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${pages} WHERE ${pages.id} = ${bioPageId} FOR UPDATE`);

    const existing = await tx.query.pages.findFirst({
      where: eq(pages.id, bioPageId),
      columns: { content: true },
    });

    const prior = stripOwnBlock(existing?.content ?? '').trimEnd();
    const next = prior ? `${prior}\n\n${block}\n` : `${block}\n`;

    await tx
      .update(pages)
      .set({ content: next, contentMode: 'markdown' })
      .where(eq(pages.id, bioPageId));
  });

  return { written: true };
}

/**
 * Remove a block previously written by this function, matching the exact
 * delimiters. Anything outside them — including a user heading that happens to
 * start with the same words — is left untouched.
 */
function stripOwnBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  if (start === -1) return content;

  const afterStart = start + BLOCK_START.length;

  // Bound the search at the next start marker so we never reach across into a
  // second block and delete what lies between.
  const nextStart = content.indexOf(BLOCK_START, afterStart);
  const regionEnd = nextStart === -1 ? content.length : nextStart;
  const region = content.slice(afterStart, regionEnd);

  // The LAST end marker in our own region, not the first. A block written
  // before user text was neutralized can contain an injected end marker
  // mid-way; stopping at the first one would leave that block's tail stranded
  // in the page forever, since every later run would strip to the same spot.
  const lastEnd = region.lastIndexOf(BLOCK_END);

  // An unterminated start marker means the page was hand-edited mid-block.
  // Leave the content entirely alone rather than guessing where it ended and
  // deleting the user's writing.
  if (lastEnd === -1) return content;

  return content.slice(0, start) + content.slice(afterStart + lastEnd + BLOCK_END.length);
}

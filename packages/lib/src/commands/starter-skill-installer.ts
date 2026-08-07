/**
 * Installs the starter skills (see starter-skills.ts) into a user's Home drive
 * as real pages, registered as personal commands so the user owns and can edit
 * them.
 *
 * Idempotence is driven by `users.starterSkillsInstalledAt`, NOT by "does a
 * command with this trigger exist?". The difference matters in both directions:
 * a user who deliberately deletes /plan must not have it resurrected on the next
 * run, and the backfill script must be safely re-runnable after a partial
 * failure. Only the stamp gives both.
 *
 * KNOWN LIMITATION — read before adding a second starter skill. The stamp is a
 * ONE-SHOT marker, not a high-water mark: it records "the initial install ran",
 * and is only ever tested for null-ness. So appending to `STARTER_SKILLS` after
 * launch reaches NEW users only — every already-stamped user is skipped here,
 * and `scripts/backfill-starter-skills.ts` cannot even see them, because its
 * query filters on `starterSkillsInstalledAt IS NULL`.
 *
 * This is latent today (there is exactly one starter) but it directly blocks the
 * planned `orchestrate`/`research`/`execute`/`brainstorm` follow-ups. Fixing it
 * needs PER-TRIGGER provenance, which a single timestamp cannot express: to add
 * a starter without resurrecting one the user deleted, you must know which
 * triggers were ever installed for that user, not merely that some install
 * happened. That is a schema change (an installed-starters ledger), and it
 * belongs to whichever PR adds the second starter — not to this one.
 *
 * SERVER-ONLY — see the note in starter-skills.ts.
 */

import { and, eq, inArray, isNull, sql } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { commands } from '@pagespace/db/schema/commands';
import {
  STARTER_SKILLS,
  STARTER_SKILLS_FOLDER_TITLE,
  STARTER_SKILL_TRIGGERS,
} from './starter-skills';

/**
 * An OPEN transaction. Deliberately not `TransactionType | typeof db`: the
 * `SELECT … FOR UPDATE` in `installStarterSkills` only serializes anything while
 * a transaction is held, and the page/command/stamp writes are only atomic
 * inside one. Admitting the bare connection would let a caller compile fine and
 * silently get neither — so the requirement the docblock states is enforced by
 * the type rather than left to a comment.
 */
export type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface InstallStarterSkillsResult {
  /** Triggers newly installed by this call. */
  installed: string[];
  /** Triggers skipped because the user already has a command with that trigger. */
  skipped: string[];
  /** True when the user was already stamped and nothing was attempted. */
  alreadyInstalled: boolean;
}

const emptyResult = (alreadyInstalled: boolean): InstallStarterSkillsResult => ({
  installed: [],
  skipped: [],
  alreadyInstalled,
});

/**
 * Find-or-create the root `Skills` folder in `homeDriveId`.
 *
 * Distinct from the `Plans` folder the plan skill creates in a working drive:
 * `Skills` holds skill definitions, `Plans` holds the artifacts they produce.
 */
async function resolveSkillsFolder(client: DbClient, homeDriveId: string): Promise<string> {
  const [existing] = await client
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.driveId, homeDriveId),
        eq(pages.title, STARTER_SKILLS_FOLDER_TITLE),
        eq(pages.type, 'FOLDER'),
        eq(pages.isTrashed, false),
        isNull(pages.parentId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = createId();
  const now = new Date();
  await client.insert(pages).values({
    id,
    title: STARTER_SKILLS_FOLDER_TITLE,
    type: 'FOLDER',
    driveId: homeDriveId,
    content: '',
    isTrashed: false,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * Install every starter skill the user does not already have a trigger for.
 *
 * Safe to call inside an existing transaction (pass the tx as `client`) — the
 * provisioning path does exactly that so a half-installed Home is impossible.
 *
 * `client` MUST be a transaction, and is deliberately required rather than
 * defaulted to `db`. The `FOR UPDATE` below only serializes anything while a
 * transaction is open — on a bare connection each statement autocommits and
 * releases the lock immediately, so a default of `db` would have silently
 * offered neither the serialization nor the all-or-nothing install this function
 * documents. Both callers already pass one (provisioning passes its own tx; the
 * backfill wraps each user in `db.transaction`).
 *
 * Given that, serialization is owned here rather than by callers: provisioning
 * happens to hold a `FOR UPDATE` on the user row already, but the backfill does
 * not, and without a lock two concurrent runs can both read a NULL stamp, both
 * pass the "already installed?" gate, and both create a Skills folder. Re-locking
 * a row the transaction already holds is a no-op in Postgres, so taking it here
 * costs provisioning nothing.
 */
export async function installStarterSkills(
  userId: string,
  homeDriveId: string,
  client: DbClient,
): Promise<InstallStarterSkillsResult> {
  if (STARTER_SKILLS.length === 0) return emptyResult(false);

  // Same lock the provisioning path takes (see onboarding/home-drive.ts), so the
  // read-then-stamp below is atomic against a concurrent installer.
  await client.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

  const [user] = await client
    .select({ starterSkillsInstalledAt: users.starterSkillsInstalledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return emptyResult(false);
  if (user.starterSkillsInstalledAt) return emptyResult(true);

  // A user may already own a command named e.g. /plan. Theirs wins — we never
  // overwrite, and the unique (user_id, trigger) constraint would reject it
  // anyway.
  const taken = new Set(
    (
      await client
        .select({ trigger: commands.trigger })
        .from(commands)
        .where(
          and(eq(commands.userId, userId), inArray(commands.trigger, [...STARTER_SKILL_TRIGGERS])),
        )
    ).map((row) => row.trigger),
  );

  const toInstall = STARTER_SKILLS.filter((skill) => !taken.has(skill.trigger));
  const skipped = STARTER_SKILLS.filter((skill) => taken.has(skill.trigger)).map((s) => s.trigger);

  const installed: string[] = [];
  if (toInstall.length > 0) {
    const folderId = await resolveSkillsFolder(client, homeDriveId);
    const now = new Date();

    for (const [index, skill] of toInstall.entries()) {
      const pageId = createId();
      await client.insert(pages).values({
        id: pageId,
        title: skill.title,
        type: 'DOCUMENT',
        driveId: homeDriveId,
        parentId: folderId,
        content: skill.body,
        contentMode: 'markdown',
        isTrashed: false,
        position: index,
        createdAt: now,
        updatedAt: now,
      });

      const registered = await client
        .insert(commands)
        .values({
          userId,
          trigger: skill.trigger,
          description: skill.description,
          entryPageId: pageId,
          type: 'document',
          createdById: userId,
          enabled: true,
        })
        // Backstop only, now that the user row is locked above: a command
        // created between our `taken` read and this insert would otherwise
        // violate the unique (user_id, trigger) constraint and abort the whole
        // transaction, taking the caller's Home drive down with it.
        .onConflictDoNothing()
        .returning({ id: commands.id });

      if (registered.length === 0) {
        // The insert was skipped, so the page we just created has no command
        // pointing at it. Leaving it would litter the user's Skills folder with
        // a document that looks like a skill but can never be invoked — and
        // reporting the trigger as "installed" would make the backfill summary
        // over-count. Drop the page and record the truth instead.
        await client.delete(pages).where(eq(pages.id, pageId));
        skipped.push(skill.trigger);
        continue;
      }

      installed.push(skill.trigger);
    }
  }

  await client
    .update(users)
    .set({ starterSkillsInstalledAt: new Date() })
    .where(eq(users.id, userId));

  return { installed, skipped, alreadyInstalled: false };
}

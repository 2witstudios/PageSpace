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
 * SERVER-ONLY — see the note in starter-skills.ts.
 */

import { and, eq, inArray, isNull } from '@pagespace/db/operators';
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

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;
export type DbClient = TransactionType | DatabaseType;

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
 */
export async function installStarterSkills(
  userId: string,
  homeDriveId: string,
  client: DbClient = db,
): Promise<InstallStarterSkillsResult> {
  if (STARTER_SKILLS.length === 0) return emptyResult(false);

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

      await client
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
        // Concurrent provisioning (two rapid OAuth callbacks) could race here;
        // losing the race is fine — the winner's command is equivalent.
        .onConflictDoNothing();

      installed.push(skill.trigger);
    }
  }

  await client
    .update(users)
    .set({ starterSkillsInstalledAt: new Date() })
    .where(eq(users.id, userId));

  return { installed, skipped, alreadyInstalled: false };
}

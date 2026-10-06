import { db } from '@pagespace/db/db'
import { eq, sql } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives, pages } from '@pagespace/db/schema/core'
import { createId } from '@paralleldrive/cuid2'
import { HOME_DRIVE_NAME, resolveUniqueSlug } from '../services/drive-guards'
import { allocatePublishSubdomain } from '../services/drive-service'
import { populateUserDrive } from './drive-setup'
import { installStarterSkills } from '../commands/starter-skill-installer'
import { provisionMemoryPages } from '../memory/memory-pages'
import { provisionImagoAgents } from '../agents/provision-imago-agents'
import { loggers } from '../logging/logger-config'

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProvisionHomeDriveResult {
  driveId: string;
  created: boolean;
}

/**
 * Provision a Home drive for the user if one does not already exist.
 *
 * Semantics of `created`:
 * - `true`  = first-time signup: Home was just seeded with a "Getting Started" folder +
 *             tutorial content. The caller should redirect to `welcome=true`.
 * - `false` = either the drive already existed, OR the user owns other drives and was
 *             reached lazily (OAuth / magic-link on every login). In the lazy case the
 *             Home is created as an EMPTY drive so the user's normal post-login
 *             `returnUrl` is never hijacked into an empty drive.
 *
 * Race safety: a `SELECT … FOR UPDATE` on the user row serialises concurrent calls
 * (e.g. two rapid OAuth callbacks for the same user). The partial unique index on
 * (ownerId) WHERE kind='HOME' provides a DB-level backstop.
 *
 * Imago agents: every call — including the existing-Home branch, so returning
 * users get them on their next sign-in — provisions the built-in Imago agents
 * in Home (`provisionImagoAgents`), recreating any the user deleted. That runs
 * in its own transaction AFTER the Home transaction commits, and a failure is
 * logged, not thrown: Home never depends on the agents (closing review F8 — a
 * persistent provisioning failure inside the Home transaction rolled Home back
 * at every sign-in). The next sign-in retries, through the existing-Home branch.
 *
 * Contention: concurrent first sign-ins of different users share the publish
 * subdomain — a rival writing the same candidate waits on this transaction's
 * uncommitted entry — so allocating it is the Home transaction's last step,
 * held only until its commit, not across the seeding. The agents' activity,
 * whose hash chain takes one global advisory lock until commit, is likewise
 * the last step of the agents' own transaction (`writeImagoAgentActivity`).
 */
export async function provisionHomeDriveIfNeeded(
  userId: string
): Promise<ProvisionHomeDriveResult> {
  const result = await db.transaction(async (tx: TransactionType) => {
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const ownedDrives = await tx.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: { id: true, kind: true, slug: true },
    });

    const homeDrive = ownedDrives.find((d) => d.kind === 'HOME');
    if (homeDrive) return { driveId: homeDrive.id, created: false };

    const isExistingUser = ownedDrives.length > 0;
    const existingSlugs = ownedDrives.map((d) => d.slug);
    const slug = resolveUniqueSlug(existingSlugs, 'home');

    const [newDrive] = await tx
      .insert(drives)
      .values({
        name: HOME_DRIVE_NAME,
        slug,
        kind: 'HOME',
        ownerId: userId,
        updatedAt: new Date(),
      })
      .returning();

    // Starter skills install on BOTH branches. They are the user's own editable
    // copies of workflow skills, not tutorial content, so an existing user
    // reaching Home lazily should get them too — and this adds content without
    // flipping `created`, so their post-login returnUrl is still not hijacked.
    await installStarterSkills(userId, newDrive.id, tx);

    // Memory pages install on BOTH branches. They hold the user's personalization
    // profile as editable markdown documents — About You, Communication, Rules.
    await provisionMemoryPages(userId, newDrive.id, tx);

    if (!isExistingUser) {
      const [folder] = await tx
        .insert(pages)
        .values({
          id: createId(),
          title: 'Getting Started',
          type: 'FOLDER',
          driveId: newDrive.id,
          content: '',
          isTrashed: false,
          position: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      await populateUserDrive(userId, newDrive.id, tx, { rootParentId: folder.id });
    }

    // Auto-allocate a globally-unique publish subdomain for the Home drive so it is
    // addressable at <sub>.pagespace.site from creation (participates in this tx).
    // Last: see "Contention" above.
    await allocatePublishSubdomain(newDrive.id, slug, tx);

    return { driveId: newDrive.id, created: !isExistingUser };
  });

  // The Imago agents install on BOTH branches, after Home has committed: they
  // are the user's assistants, not tutorial content, and never a reason to
  // lose Home.
  try {
    await provisionImagoAgents(userId)
  } catch (error) {
    loggers.ai.error('Imago agents: provisioning failed; retried at next sign-in', error as Error, { userId })
  }
  return result;
}

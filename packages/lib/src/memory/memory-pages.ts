/**
 * Memory Pages Service
 *
 * The user's personalization profile lives as three editable markdown pages in
 * a `Memory` folder in their Home drive, rather than as opaque DB text columns.
 * This module owns locating, creating, and reading those pages.
 *
 * Pattern follows `packages/lib/src/commands/starter-skill-installer.ts`.
 */

import { and, eq, inArray, isNull, or, sql } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { getHomeDrive } from '../services/drive-service';

export const MEMORY_FOLDER_TITLE = 'Memory';

export const MEMORY_PAGE_TITLES = {
  bio: 'About You',
  writingStyle: 'Communication',
  rules: 'Rules',
} as const;

export type MemoryField = keyof typeof MEMORY_PAGE_TITLES;

export const MEMORY_FIELDS: readonly MemoryField[] = ['bio', 'writingStyle', 'rules'];

/** Column on `user_personalization` holding each field's page pointer. */
const POINTER_COLUMN = {
  bio: 'bioPageId',
  writingStyle: 'writingStylePageId',
  rules: 'rulesPageId',
} as const;

/**
 * Refusal shown when someone tries to trash a memory page or its folder.
 *
 * Names both alternatives, strongest first: the toggle is the complete answer
 * for "stop using this", and emptying the page is the answer for "remove this
 * content". Between them there is nothing deletion would additionally achieve.
 */
export const MEMORY_PAGE_DELETE_ERROR =
  'Memory pages hold what the AI knows about you and cannot be deleted. To stop the AI using them, turn personalization off in Settings; to erase what one says, clear the page.';

/**
 * Whether this page is one of the protected memory pages, or their folder.
 *
 * These are structural, like the Home drive itself: the cron writes to them by
 * pointer, the settings screen links to them, and provisioning assumes they
 * exist. Deleting one leaves a user whose profile has nowhere to live — the
 * pointer nulls, the settings screen shows a dead link, and the next run
 * silently writes nothing.
 *
 * ── Why refusing costs the user nothing ──────────────────────────────────────
 * Deletion is a REDUNDANT path here, not a missing one. Everything someone
 * could want from deleting a memory page is already available and reversible:
 *
 *   - "I don't want this content" → empty the page.
 *   - "I don't want the AI using any of this" → turn personalization off in
 *     Settings, which stops the whole feature reading or writing.
 *
 * Deletion adds no capability over those two; it only adds a broken state the
 * rest of the system then has to tolerate. That is the reasoning behind this
 * guard — please do not reintroduce deletion as a "missing feature" without
 * first replacing what the toggle and the empty-page path already provide.
 */
export async function isProtectedMemoryPage(pageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userPersonalization.id })
    .from(userPersonalization)
    .where(
      or(
        eq(userPersonalization.memoryFolderId, pageId),
        eq(userPersonalization.bioPageId, pageId),
        eq(userPersonalization.writingStylePageId, pageId),
        eq(userPersonalization.rulesPageId, pageId),
      ),
    )
    .limit(1);

  return Boolean(row);
}

/**
 * The subset of `pageIds` that are protected memory pages.
 *
 * One query for the bulk-delete path, which would otherwise fan out to one
 * round trip per page.
 */
export async function findProtectedMemoryPages(pageIds: string[]): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();

  const rows = await db
    .select({
      memoryFolderId: userPersonalization.memoryFolderId,
      bioPageId: userPersonalization.bioPageId,
      writingStylePageId: userPersonalization.writingStylePageId,
      rulesPageId: userPersonalization.rulesPageId,
    })
    .from(userPersonalization)
    .where(
      or(
        inArray(userPersonalization.memoryFolderId, pageIds),
        inArray(userPersonalization.bioPageId, pageIds),
        inArray(userPersonalization.writingStylePageId, pageIds),
        inArray(userPersonalization.rulesPageId, pageIds),
      ),
    );

  const requested = new Set(pageIds);
  const protectedIds = new Set<string>();
  for (const row of rows) {
    for (const id of [row.memoryFolderId, row.bioPageId, row.writingStylePageId, row.rulesPageId]) {
      if (id && requested.has(id)) protectedIds.add(id);
    }
  }
  return protectedIds;
}

/**
 * An OPEN transaction. See `starter-skill-installer.ts` for why this is
 * required rather than defaulted to the bare connection: the `FOR UPDATE`
 * below only serializes anything while a transaction is held.
 */
export type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Find or create the root Memory folder in the Home drive.
 *
 * Distinct from the `Skills` folder the starter-skill installer creates:
 * `Memory` holds personalization content, `Skills` holds skill definitions.
 */
export async function resolveMemoryFolder(
  client: DbClient,
  homeDriveId: string,
): Promise<string> {
  const [existing] = await client
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.driveId, homeDriveId),
        eq(pages.title, MEMORY_FOLDER_TITLE),
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
    title: MEMORY_FOLDER_TITLE,
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
 * Find or create a specific memory page within the Memory folder.
 *
 * Resolution order: the stored pointer (when that page is still alive) → a live
 * page with the expected title in the folder → a newly created page.
 *
 * Callers own the stored pointer. This function never writes to
 * `user_personalization`; it only reports which page id the field should point
 * at, and `provisionMemoryPages` persists that.
 */
export async function resolveMemoryPage(
  client: DbClient,
  homeDriveId: string,
  folderId: string,
  field: MemoryField,
  existingPageId: string | null,
): Promise<string> {
  if (existingPageId) {
    const [existing] = await client
      .select({ id: pages.id, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, existingPageId))
      .limit(1);

    if (existing && !existing.isTrashed) return existing.id;
    // Otherwise the pointer is stale (hard-deleted or trashed) and falls
    // through; the caller overwrites it with whatever we return below.
  }

  const title = MEMORY_PAGE_TITLES[field];
  const [byTitle] = await client
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.driveId, homeDriveId),
        eq(pages.parentId, folderId),
        eq(pages.title, title),
        eq(pages.type, 'DOCUMENT'),
        eq(pages.isTrashed, false),
      ),
    )
    .limit(1);

  if (byTitle) return byTitle.id;

  const id = createId();
  const now = new Date();
  await client.insert(pages).values({
    id,
    title,
    type: 'DOCUMENT',
    driveId: homeDriveId,
    parentId: folderId,
    content: '',
    contentMode: 'markdown',
    isTrashed: false,
    position: MEMORY_FIELDS.indexOf(field),
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

/**
 * Read the live memory pages for a user, keyed by field.
 *
 * A field is absent from the result when it has no pointer, or when the page it
 * points at has been trashed or deleted — which reads downstream as "this field
 * is empty", never as a reason to resurrect the page.
 */
export async function readMemoryPages(
  userId: string,
): Promise<Partial<Record<MemoryField, string>>> {
  const [personalization, homeDrive] = await Promise.all([
    db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, userId),
    }),
    getHomeDrive(userId),
  ]);

  if (!personalization || !homeDrive) return {};

  // Build the id→field map from live pointers only, so a null pointer can never
  // become a "null" string key that a stray row could collide with.
  const idToField = new Map<string, MemoryField>();
  for (const field of MEMORY_FIELDS) {
    const pageId = personalization[POINTER_COLUMN[field]];
    if (pageId) idToField.set(pageId, field);
  }

  if (idToField.size === 0) return {};

  const foundPages = await db
    .select({ id: pages.id, content: pages.content })
    .from(pages)
    .where(
      and(
        eq(pages.driveId, homeDrive.id),
        inArray(pages.id, [...idToField.keys()]),
        eq(pages.isTrashed, false),
      ),
    );

  const result: Partial<Record<MemoryField, string>> = {};
  for (const page of foundPages) {
    const field = idToField.get(page.id);
    if (field) result[field] = page.content ?? '';
  }

  return result;
}

/**
 * Ensure the Memory folder and all three pages exist, and record their ids.
 *
 * Safe to call repeatedly: pages the user still has are reused, pages they
 * deleted are recreated empty only because this is the provisioning path that
 * is meant to guarantee the folder exists.
 *
 * `client` MUST be a transaction — the `FOR UPDATE` on the user row (the same
 * row `installStarterSkills` locks) only serializes concurrent provisioning
 * while one is held. Locking `users` rather than `user_personalization` matters:
 * a first-time user has no `user_personalization` row yet, and `FOR UPDATE`
 * over zero rows locks nothing at all.
 */
export async function provisionMemoryPages(
  userId: string,
  homeDriveId: string,
  client: DbClient,
): Promise<{
  folderId: string;
  bioPageId: string;
  writingStylePageId: string;
  rulesPageId: string;
}> {
  await client.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

  const [existing] = await client
    .select({
      memoryFolderId: userPersonalization.memoryFolderId,
      bioPageId: userPersonalization.bioPageId,
      writingStylePageId: userPersonalization.writingStylePageId,
      rulesPageId: userPersonalization.rulesPageId,
    })
    .from(userPersonalization)
    .where(eq(userPersonalization.userId, userId))
    .limit(1);

  const stored = existing ?? {
    memoryFolderId: null,
    bioPageId: null,
    writingStylePageId: null,
    rulesPageId: null,
  };

  // Re-resolve the folder rather than trusting the stored id blindly: a trashed
  // folder would otherwise become the parent of three fresh, invisible pages.
  const folderId = await resolveLiveFolder(client, homeDriveId, stored.memoryFolderId);

  const bioPageId = await resolveMemoryPage(client, homeDriveId, folderId, 'bio', stored.bioPageId);
  const writingStylePageId = await resolveMemoryPage(
    client,
    homeDriveId,
    folderId,
    'writingStyle',
    stored.writingStylePageId,
  );
  const rulesPageId = await resolveMemoryPage(
    client,
    homeDriveId,
    folderId,
    'rules',
    stored.rulesPageId,
  );

  const pointers = {
    memoryFolderId: folderId,
    bioPageId,
    writingStylePageId,
    rulesPageId,
    updatedAt: new Date(),
  };

  await client
    .insert(userPersonalization)
    .values({ userId, ...pointers, enabled: true })
    .onConflictDoUpdate({
      target: userPersonalization.userId,
      set: pointers,
    });

  return { folderId, bioPageId, writingStylePageId, rulesPageId };
}

/** Return the stored folder id when it still points at a live folder, else find-or-create. */
async function resolveLiveFolder(
  client: DbClient,
  homeDriveId: string,
  storedFolderId: string | null,
): Promise<string> {
  if (storedFolderId) {
    const [folder] = await client
      .select({ id: pages.id, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, storedFolderId))
      .limit(1);

    if (folder && !folder.isTrashed) return folder.id;
  }

  return resolveMemoryFolder(client, homeDriveId);
}

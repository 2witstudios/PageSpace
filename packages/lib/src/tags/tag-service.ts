/**
 * Imperative shell for content tags.
 *
 * Every DECISION lives in the pure cores — `tag-core.ts` for names and target
 * validity, `../content/anchoring/` for anchor maths. This module only does
 * I/O: permission checks, reads, writes, and the re-anchoring sweep. It follows
 * `../services/page-webhook-service.ts`: imports the `db` singleton rather than
 * taking a db param, and NEVER throws across the boundary — every failure comes
 * back as a discriminated result so callers map outcomes without a try/catch.
 *
 * Authorization goes through the centralized permission functions only, per
 * CLAUDE.md. There is no bespoke access logic in this file, and there must not
 * be: content tags are readable exactly when their page is readable and
 * writable exactly when their page is writable, which is the whole reason
 * `content_tags.pageId` is NOT NULL on every row including the message kinds.
 *
 * NOTHING CALLS THIS YET. No API route, no UI — that is Phase 4. Two
 * consequences are load-bearing and are spelled out at `reanchorPageTags` and
 * in the epic: the save-path hook and the cross-drive-move scrub must land
 * before any write path ships, not after.
 *
 * @module @pagespace/lib/tags/tag-service
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { contentTags } from '@pagespace/db/schema/content-tags';
import { tags, pages } from '@pagespace/db/schema/core';
import type { ContentTagSource } from '@pagespace/db/schema/content-tags';
import { canUserViewPage, canUserEditPage, getBatchPagePermissions, isUserDriveMember } from '../permissions/permissions';
import { loggers } from '../logging/logger-config';
import { normalizeTagName, validateTarget, type TagTarget } from './tag-core';
import type { TextAnchor } from '../content/anchoring/types';
import { preparePort, portPreparedAnchor } from '../content/anchoring/reanchor';
import { projectContent, resolveProjectionFormat } from '../content/anchoring/text-projection';
import { resolveAnchor } from '../content/anchoring/resolve';
import { hashText } from '../content/anchoring/anchor';

const log = loggers.system;

/**
 * A drizzle transaction, or the `db` singleton when there is no outer one.
 *
 * Same spelling the other lib repositories use (page-content-store,
 * drive-service, storage-repository). Only `reanchorPageTags` takes one: it is
 * the one entry point that MUST commit atomically with somebody else's write.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type TagExecutor = Tx | typeof db;

/**
 * Machine-readable failure codes. Callers map these to status codes, so they
 * are part of this module's contract — renaming one is a breaking change.
 *
 * `forbidden` deliberately covers "no such page" as well as "no access": a
 * distinct `not_found` would let a caller probe which page ids exist in drives
 * they cannot see.
 */
export type TagErrorCode =
  | 'forbidden'
  | 'invalid_name'
  | 'invalid_target'
  | 'tag_not_found'
  | 'assignment_not_found'
  /** This exact assignment already exists. A user re-tagging, not a server fault. */
  | 'assignment_exists'
  | 'internal_error';

export type TagResult<T> = { ok: true; data: T } | { ok: false; error: TagErrorCode; message?: string };

const fail = (error: TagErrorCode, message?: string): { ok: false; error: TagErrorCode; message?: string } =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };

const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

/** A tag in a drive's vocabulary. */
export type DriveTag = {
  id: string;
  name: string;
  normalizedKey: string;
  color: string | null;
  description: string | null;
};

/** One assignment, joined to the vocabulary row it points at. */
export type PageTagAssignment = {
  id: string;
  tagId: string;
  name: string;
  color: string | null;
  pageId: string;
  targetKind: string;
  anchor: unknown;
  anchorStatus: string | null;
  channelMessageId: string | null;
  aiMessageId: string | null;
  source: string;
  confidence: number | null;
};

/**
 * Every unexpected throw funnels here. Errors are logged rather than
 * propagated because this module promises not to throw; the code is always
 * `internal_error` so a driver message never reaches a caller that might
 * surface it to a user.
 */
function unexpected(operation: string, error: unknown): { ok: false; error: TagErrorCode } {
  log.error(`tag-service: ${operation} failed`, error as Error, { operation });
  return { ok: false, error: 'internal_error' };
}

/**
 * Postgres unique-violation, seen through drizzle.
 *
 * drizzle 0.45.2 rethrows driver errors wrapped as `DrizzleQueryError` with the
 * pg error on `.cause`, so a top-level `error.code` check never matches and the
 * conflict silently becomes a 500. Both levels are checked here for that reason.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

/**
 * The drive's tag vocabulary.
 *
 * Drive membership, not page permission: the vocabulary is drive-scoped and
 * says nothing about which pages carry which tag, so a member may read it
 * whole. Which ASSIGNMENTS they can see is a separate question, answered
 * per-page by `getPageTags`.
 */
export async function listDriveTags(driveId: string, userId: string): Promise<TagResult<DriveTag[]>> {
  try {
    if (!(await isUserDriveMember(userId, driveId))) return fail('forbidden');

    const rows = await db
      .select({
        id: tags.id,
        name: tags.name,
        normalizedKey: tags.normalizedKey,
        color: tags.color,
        description: tags.description,
      })
      .from(tags)
      .where(eq(tags.driveId, driveId));

    return ok(rows);
  } catch (error) {
    return unexpected('listDriveTags', error);
  }
}

/**
 * Get or create a tag by name, within one drive.
 *
 * RACES ON `(driveId, normalizedKey)`, which is exactly what the unique
 * constraint is for. Two users typing the same tag at once is the ordinary
 * case, not the exceptional one, so this does not try to win the race: it
 * inserts with `onConflictDoNothing` and, when that returns nothing, reads the
 * row the other writer committed.
 *
 * Deliberately NOT a `.catch(e => e.code === '23505')`. Drizzle 0.45.2 rethrows
 * pg errors wrapped as `DrizzleQueryError` with the driver error on `.cause`,
 * so a top-level code check silently never matches and the 409 path becomes a
 * 500. `onConflictDoNothing` sidesteps the question entirely.
 *
 * An existing tag is returned UNMODIFIED — `color` and `description` are not
 * overwritten from a later call. Upsert here means "get or create", not "get or
 * update": tagging a page must never silently restyle a shared vocabulary
 * entry for everyone else in the drive.
 */
export async function upsertTag(
  driveId: string,
  userId: string,
  input: { name: string; color?: string; description?: string },
): Promise<TagResult<DriveTag>> {
  try {
    if (!(await isUserDriveMember(userId, driveId))) return fail('forbidden');

    const normalized = normalizeTagName(input.name);
    if (!normalized.ok) return fail('invalid_name', normalized.reason);

    const inserted = await db
      .insert(tags)
      .values({
        driveId,
        name: normalized.name,
        normalizedKey: normalized.key,
        color: input.color ?? null,
        description: input.description ?? null,
        createdBy: userId,
      })
      .onConflictDoNothing({ target: [tags.driveId, tags.normalizedKey] })
      .returning({
        id: tags.id,
        name: tags.name,
        normalizedKey: tags.normalizedKey,
        color: tags.color,
        description: tags.description,
      });

    if (inserted.length > 0) return ok(inserted[0]);

    // Lost the race (or it already existed): read the winner's row.
    const existing = await db
      .select({
        id: tags.id,
        name: tags.name,
        normalizedKey: tags.normalizedKey,
        color: tags.color,
        description: tags.description,
      })
      .from(tags)
      .where(and(eq(tags.driveId, driveId), eq(tags.normalizedKey, normalized.key)))
      .limit(1);

    if (existing.length === 0) {
      // Only reachable if the conflicting row was deleted between the insert
      // and this read. Reporting internal_error rather than retrying forever.
      return fail('internal_error', 'tag vanished between insert and read');
    }
    return ok(existing[0]);
  } catch (error) {
    return unexpected('upsertTag', error);
  }
}

/**
 * Whether a value is structurally a TextAnchor.
 *
 * `validateTarget` (the pure core) answers which KINDS a page type accepts; it
 * does not inspect the anchor's scalars, and the compiler cannot help at a
 * service boundary that receives parsed JSON. Without this, `exact: 1` persists
 * happily and every later sweep casts it back to TextAnchor and either resolves
 * against nonsense or throws mid-loop, taking the whole sweep with it.
 */
function isTextAnchor(value: unknown): value is TextAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    a.v === 1 &&
    typeof a.exact === 'string' &&
    typeof a.prefix === 'string' &&
    typeof a.suffix === 'string' &&
    Number.isInteger(a.start) &&
    Number.isInteger(a.end) &&
    (a.start as number) >= 0 &&
    (a.end as number) >= (a.start as number) &&
    Number.isInteger(a.revision) &&
    typeof a.textHash === 'string' &&
    a.textHash.length > 0
  );
}

/** Columns a target kind contributes to a `content_tags` row. */
function targetColumns(target: TagTarget): {
  targetKind: TagTarget['kind'];
  anchor: unknown;
  anchorStatus: 'exact' | null;
  channelMessageId: string | null;
  aiMessageId: string | null;
} {
  // Mirrors the five-branch CHECK in migration 0270 exactly. Kept as one
  // switch so the constraint and this builder can be read side by side: a
  // sixth kind fails to compile here rather than failing at INSERT.
  switch (target.kind) {
    case 'page':
      return { targetKind: 'page', anchor: null, anchorStatus: null, channelMessageId: null, aiMessageId: null };
    case 'text':
      // anchorStatus is NOT NULL for 'text' in the CHECK; a freshly created
      // anchor is by definition exact against the revision it was measured on.
      return { targetKind: 'text', anchor: target.anchor, anchorStatus: 'exact', channelMessageId: null, aiMessageId: null };
    case 'sheet_cell':
      return { targetKind: 'sheet_cell', anchor: target.anchor, anchorStatus: null, channelMessageId: null, aiMessageId: null };
    case 'channel_message':
      return { targetKind: 'channel_message', anchor: null, anchorStatus: null, channelMessageId: target.channelMessageId, aiMessageId: null };
    case 'ai_message':
      return { targetKind: 'ai_message', anchor: null, anchorStatus: null, channelMessageId: null, aiMessageId: target.aiMessageId };
  }
}

/**
 * Attach a tag to a page, or to something inside it.
 *
 * `pageId` is required on EVERY kind, including the message kinds, because it
 * is what permission checks key on — the scope trigger from migration 0272
 * enforces that the message actually belongs to that page, so a caller cannot
 * borrow a page they can edit to tag a message they cannot.
 *
 * Accepts either an existing `tagId` or a `name` to get-or-create. The name
 * path runs through `upsertTag`, so it inherits the race handling.
 */
export async function applyTag(
  userId: string,
  input: {
    pageId: string;
    tagId?: string;
    name?: string;
    target: TagTarget;
    source: ContentTagSource;
    confidence?: number;
  },
): Promise<TagResult<{ id: string }>> {
  try {
    if (!(await canUserEditPage(userId, input.pageId))) return fail('forbidden');

    const page = await db
      .select({
        id: pages.id,
        type: pages.type,
        driveId: pages.driveId,
        content: pages.content,
        contentMode: pages.contentMode,
      })
      .from(pages)
      .where(eq(pages.id, input.pageId))
      .limit(1);
    if (page.length === 0) return fail('forbidden');

    // The pure core owns which kinds this page type accepts.
    const targetCheck = validateTarget(page[0].type, input.target);
    if (!targetCheck.ok) return fail('invalid_target', targetCheck.reason);

    // A text target carries an anchor built by a CLIENT, which makes it
    // untrusted twice over: structurally (it is parsed JSON, so the compiler
    // guarantees nothing) and temporally (a collaborative edit can land between
    // the client measuring it and this call).
    let target = input.target;
    /**
     * Set when a client anchor had to be repaired onto the current revision.
     *
     * Includes 'exact': a repair CAN land back on the recorded offsets with the
     * quote byte-identical, and that is a genuine exact match against the
     * revision now being stored, not a claim inherited from a stale one.
     */
    let staleAnchorStatus: 'exact' | 'shifted' | 'fuzzy' | null = null;
    if (target.kind === 'text') {
      if (!isTextAnchor(target.anchor)) {
        return fail('invalid_target', 'anchor is not a well-formed TextAnchor');
      }

      // Storing a client anchor as 'exact' against a revision it was not
      // measured on is a lie the next sweep pays for: the staleness guard
      // rejects it and the anchor is never ported again. Repair it against the
      // page as it stands NOW, and record what that repair actually achieved.
      const currentText = projectContent(page[0].content ?? '', page[0].contentMode);
      const currentHash = hashText(currentText);
      if (target.anchor.textHash !== currentHash) {
        const repaired = resolveAnchor(currentText, target.anchor);
        if (repaired.status === 'orphaned') {
          return fail('invalid_target', 'anchored text is not present in the current revision');
        }
        target = {
          kind: 'text',
          anchor: {
            ...target.anchor,
            start: repaired.start,
            end: repaired.end,
            textHash: currentHash,
          },
        };
        staleAnchorStatus = repaired.status;
      }
    }

    let tagId = input.tagId;
    if (!tagId) {
      if (!input.name) return fail('invalid_name', 'either tagId or name is required');
      const upserted = await upsertTag(page[0].driveId, userId, { name: input.name });
      if (!upserted.ok) return upserted;
      tagId = upserted.data.id;
    } else {
      // A tagId from another drive would be caught by the scope trigger at
      // INSERT, but that surfaces as a raw driver error. Check it here so the
      // caller gets `tag_not_found` instead of `internal_error`.
      const owned = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.driveId, page[0].driveId)))
        .limit(1);
      if (owned.length === 0) return fail('tag_not_found');
    }

    const cols = targetColumns(target);
    // 'exact' means confidence 1 against the stored revision. A repaired anchor
    // reached its offsets by search, so it says so rather than claiming exact.
    const anchorStatus = staleAnchorStatus ?? cols.anchorStatus;
    const inserted = await db
      .insert(contentTags)
      .values({
        tagId,
        pageId: input.pageId,
        targetKind: cols.targetKind,
        anchor: cols.anchor,
        anchorStatus,
        channelMessageId: cols.channelMessageId,
        aiMessageId: cols.aiMessageId,
        source: input.source,
        confidence: input.confidence ?? null,
        createdBy: userId,
      })
      .returning({ id: contentTags.id });

    return ok({ id: inserted[0].id });
  } catch (error) {
    // A second page-level assignment of the same tag trips
    // `content_tags_page_target_unique`. That is a user tagging something
    // twice, not a fault — callers need to tell it apart from a real failure.
    if (isUniqueViolation(error)) return fail('assignment_exists');
    return unexpected('applyTag', error);
  }
}

/**
 * Detach one assignment.
 *
 * Permission is checked against the row's OWN `pageId`, read first — not
 * against anything the caller supplies — so a caller cannot pass an id from a
 * page they cannot edit.
 */
export async function removeTag(userId: string, contentTagId: string): Promise<TagResult<{ id: string }>> {
  try {
    const row = await db
      .select({ id: contentTags.id, pageId: contentTags.pageId })
      .from(contentTags)
      .where(eq(contentTags.id, contentTagId))
      .limit(1);
    if (row.length === 0) return fail('assignment_not_found');

    if (!(await canUserEditPage(userId, row[0].pageId))) return fail('forbidden');

    await db.delete(contentTags).where(eq(contentTags.id, contentTagId));
    return ok({ id: contentTagId });
  } catch (error) {
    return unexpected('removeTag', error);
  }
}

/** The select list shared by the single- and batch-page read paths. */
const assignmentColumns = {
  id: contentTags.id,
  tagId: contentTags.tagId,
  name: tags.name,
  color: tags.color,
  pageId: contentTags.pageId,
  targetKind: contentTags.targetKind,
  anchor: contentTags.anchor,
  anchorStatus: contentTags.anchorStatus,
  channelMessageId: contentTags.channelMessageId,
  aiMessageId: contentTags.aiMessageId,
  source: contentTags.source,
  confidence: contentTags.confidence,
};

/** Every assignment on one page. */
export async function getPageTags(userId: string, pageId: string): Promise<TagResult<PageTagAssignment[]>> {
  try {
    if (!(await canUserViewPage(userId, pageId))) return fail('forbidden');

    const rows = await db
      .select(assignmentColumns)
      .from(contentTags)
      .innerJoin(tags, eq(contentTags.tagId, tags.id))
      .where(eq(contentTags.pageId, pageId));

    return ok(rows);
  } catch (error) {
    return unexpected('getPageTags', error);
  }
}

/**
 * Assignments for many pages at once — for decorating search results later.
 *
 * Filters to the viewable subset FIRST and queries only those, so an
 * unauthorized id can never contribute a row. `getBatchPagePermissions`
 * pre-seeds every requested id with an all-false deny entry, so the `.get(id)!`
 * is total; it is still written defensively because a future change to that
 * pre-seeding must not silently turn this into a leak.
 *
 * Pages the caller cannot view are OMITTED from the returned map rather than
 * mapped to an empty array: "no tags" and "not allowed to know" are different
 * answers, and a caller rendering them the same way should have to choose that.
 */
export async function getBatchPageTags(
  userId: string,
  pageIds: string[],
): Promise<TagResult<Map<string, PageTagAssignment[]>>> {
  try {
    const result = new Map<string, PageTagAssignment[]>();
    if (pageIds.length === 0) return ok(result);

    const unique = [...new Set(pageIds)];
    const permissions = await getBatchPagePermissions(userId, unique);
    const viewable = unique.filter((id) => permissions.get(id)?.canView === true);
    if (viewable.length === 0) return ok(result);

    for (const id of viewable) result.set(id, []);

    const rows = await db
      .select(assignmentColumns)
      .from(contentTags)
      .innerJoin(tags, eq(contentTags.tagId, tags.id))
      .where(inArray(contentTags.pageId, viewable));

    for (const row of rows) {
      // `viewable` seeded every key above, so this bucket always exists.
      result.get(row.pageId)?.push(row);
    }

    return ok(result);
  } catch (error) {
    return unexpected('getBatchPageTags', error);
  }
}

/** What one re-anchoring sweep did. Counts, not rows: callers log this. */
export type ReanchorSummary = {
  /** Anchors examined — 'text' assignments only; other kinds need no porting. */
  considered: number;
  /** Anchors whose status or offsets changed and were written back. */
  updated: number;
  /** Anchors that became 'orphaned' in this sweep. Included in `updated`. */
  orphaned: number;
  /** Skipped because the stored projection hash did not match `oldContent`. */
  skippedStaleHash: number;
  /** Skipped because the projection format flipped between the two revisions. */
  skippedFormatFlip: number;
};

/**
 * Forward-port every 'text' anchor on a page across one content change.
 *
 * THE PRIMARY ANCHORING MECHANISM. Quote repair is the fallback, reached only
 * when there is no diffable predecessor; this is the path that keeps offsets
 * exact, including through duplicated quote text that search alone cannot
 * disambiguate.
 *
 * NOT WIRED UP YET, and that is the single most important thing to know about
 * this function. It has to be called from `applyPageMutation` — the one
 * transaction holding both `previousContent` and `nextContent` — and from
 * `convert-content-mode`. Until it is, every edit silently degrades anchors to
 * the repair floor. Safe only because nothing writes tags yet; it MUST land
 * before any write path ships.
 *
 * Two guards implement the caller contract `portAnchor` documents but cannot
 * enforce from inside:
 *
 *  - **Format flip.** `resolveProjectionFormat` is sniffed per revision, and a
 *    page whose markup gains an unclosed trailing element projects as raw text
 *    where the previous revision projected as stripped prose. Porting across
 *    that compares two different coordinate systems and mislays every anchor
 *    confidently. If the two revisions disagree, this sweep does nothing and
 *    says so. The durable fix is a stored per-page format — see the epic; it
 *    was assigned to Phase 2's schema and did not ship.
 *  - **Stale hash.** `anchor.textHash` pins the exact projection the anchor was
 *    measured against. An anchor whose hash does not match `oldContent`'s
 *    projection was built against some other revision, so porting it forward
 *    would produce a confident wrong answer. Left untouched for a later repair
 *    pass rather than guessed at.
 *
 * The diff is hoisted: `preparePort` runs ONCE for the transition and each
 * anchor is ported against it. Phase 0 measured the diff at 13.9s for 20KB of
 * change, so looping `portAnchor` here would multiply that by the number of
 * anchors for an identical result.
 *
 * No permission check: this is a system-triggered consequence of a page edit
 * the caller has already authorized, not a user action. It takes no `userId`
 * precisely so it cannot be mistaken for one.
 */
export type ReanchorOptions = {
  /**
   * The caller's transaction. `applyPageMutation` holds `previousContent` and
   * `nextContent` in ONE transaction and writes a version row there; the sweep
   * has to commit with it or not at all. Running outside it means either
   * anchors ported to content that then rolls back, or a committed page whose
   * anchors were only partly updated before an error. Defaults to `db` for a
   * standalone sweep (a backfill), which is the only case with no outer write.
   */
  executor?: TagExecutor;
  /**
   * `pages.contentMode` for the OLD revision, when it differs from the new one.
   *
   * Needed for `convert-content-mode`, where the two revisions are genuinely in
   * different modes. Reading one mode for both is wrong in both directions: the
   * old mode makes the formats look like an accidental flip and skips the
   * sweep, while the new mode projects the old HTML as raw text so every
   * correctly built anchor fails its hash check. Omit both for an ordinary
   * edit, where the page's stored mode applies to both revisions.
   */
  oldContentMode?: string;
  /** `pages.contentMode` for the NEW revision. See `oldContentMode`. */
  newContentMode?: string;
};

export async function reanchorPageTags(
  pageId: string,
  oldContent: string,
  newContent: string,
  options: ReanchorOptions = {},
): Promise<TagResult<ReanchorSummary>> {
  const exec = options.executor ?? db;
  const summary: ReanchorSummary = {
    considered: 0,
    updated: 0,
    orphaned: 0,
    skippedStaleHash: 0,
    skippedFormatFlip: 0,
  };

  try {
    const page = await exec
      .select({ contentMode: pages.contentMode })
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);
    if (page.length === 0) return fail('assignment_not_found', 'page not found');

    const storedMode = page[0].contentMode;
    const oldMode = options.oldContentMode ?? storedMode;
    const newMode = options.newContentMode ?? storedMode;
    /** The caller told us the modes differ, so a format difference is intended. */
    const conversion = oldMode !== newMode;

    const rows = await exec
      .select({ id: contentTags.id, anchor: contentTags.anchor, anchorStatus: contentTags.anchorStatus })
      .from(contentTags)
      .where(and(eq(contentTags.pageId, pageId), eq(contentTags.targetKind, 'text')));

    summary.considered = rows.length;
    if (rows.length === 0) return ok(summary);

    // Both guards are per-transition, so they are decided once, before any
    // per-anchor work.
    // An UNDECLARED format change is the accidental flip: same mode, but the
    // sniffer read the two revisions differently (unclosed trailing markup is
    // the usual cause). The two projections are then incompatible coordinate
    // systems and porting across them mislays every anchor confidently, so the
    // sweep does nothing and says so.
    //
    // A DECLARED conversion is not that. The modes differ because the caller
    // converted the document on purpose, and the two projections are expected
    // to disagree — which is exactly why the epic routes convert-content-mode
    // to quote repair rather than forward-porting. Letting it through is what
    // makes that fallback reachable: the old projection still validates each
    // anchor's hash, and the wholesale difference then routes every anchor to
    // `resolveAnchor` against the new text.
    if (
      !conversion &&
      resolveProjectionFormat(oldContent, oldMode) !== resolveProjectionFormat(newContent, newMode)
    ) {
      summary.skippedFormatFlip = rows.length;
      log.warn('tag-service: projection format flipped between revisions; skipping re-anchor', { pageId, anchors: rows.length });
      return ok(summary);
    }

    const oldText = projectContent(oldContent, oldMode);
    const newText = projectContent(newContent, newMode);
    const oldHash = hashText(oldText);

    const newHash = hashText(newText);
    const prepared = preparePort(oldText, newText);

    for (const row of rows) {
      const anchor = row.anchor as TextAnchor | null;
      if (!anchor || anchor.textHash !== oldHash) {
        summary.skippedStaleHash += 1;
        continue;
      }

      const resolution = portPreparedAnchor(prepared, anchor);

      // AnchorResolution is a union: 'orphaned' carries NO offsets, because
      // there is nowhere for them to point. Keep the last known start/end on
      // an orphan rather than inventing or zeroing them — a later repair pass
      // uses them as a search hint, and zeroes would read as "found at the top
      // of the document". The status is what marks it unusable.
      const ported =
        resolution.status === 'orphaned'
          ? { start: anchor.start, end: anchor.end }
          : { start: resolution.start, end: resolution.end };

      // Skip the write only when NOTHING the row stores would change —
      // including the hash.
      //
      // An earlier version compared status and offsets alone. That is wrong in
      // the most ordinary case there is: an edit BELOW the anchored range
      // leaves the status 'exact' and the offsets untouched, so the write was
      // skipped and the row kept the PREVIOUS revision's textHash. The next
      // sweep's staleness guard then rejected that anchor and it silently
      // stopped being forward-ported, permanently. Writing below your anchors
      // is how documents get written, so this quietly killed the primary
      // mechanism for most tags on most pages.
      if (
        resolution.status === row.anchorStatus &&
        ported.start === anchor.start &&
        ported.end === anchor.end &&
        anchor.textHash === newHash
      ) {
        continue;
      }

      await exec
        .update(contentTags)
        .set({
          // textHash re-pins the anchor to the projection it now describes, so
          // the next sweep's staleness guard compares against the right one.
          anchor: { ...anchor, start: ported.start, end: ported.end, textHash: newHash },
          anchorStatus: resolution.status,
        })
        .where(eq(contentTags.id, row.id));

      summary.updated += 1;
      if (resolution.status === 'orphaned') summary.orphaned += 1;
    }

    return ok(summary);
  } catch (error) {
    return unexpected('reanchorPageTags', error);
  }
}

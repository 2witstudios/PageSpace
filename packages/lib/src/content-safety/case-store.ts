/**
 * Content cases — the database edge for takedowns: open a case, record its
 * steps, write the block, and read cases back for the admin console.
 *
 * While a case runs, `steps` and `snapshot` are only ever appended to or merged
 * in SQL, never read-modified-written, so two runs of the same case cannot lose
 * each other's entries. (Reopening a case merges its options in code first;
 * that happens before a run starts, not during one.)
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, gte, inArray, lte, or, sql } from '@pagespace/db/operators';
import {
  contentBlocks,
  contentCases,
  type ContentBlockCategory,
  type ContentCase,
  type ContentCaseSnapshot,
  type ContentCaseStatus,
  type ContentCaseTargetType,
} from '@pagespace/db/schema/content-safety';
import { collectContentReferences } from './references';
import type { TakedownCaseStore } from './takedown';

type TakedownOptions = NonNullable<ContentCaseSnapshot['takedown']>;

/** Which takedown a case runs lives on its snapshot; this is the one place that knows where. */
const takedownKindIs = (kind: TakedownOptions['kind']) => sql`${contentCases.snapshot} -> 'takedown' ->> 'kind' = ${kind}`;

export function createTakedownCaseStore(): TakedownCaseStore {
  return {
    load: getContentCase,
    async appendStep(caseId, step) {
      await db
        .update(contentCases)
        .set({ steps: sql`coalesce(${contentCases.steps}, '[]'::jsonb) || ${JSON.stringify([step])}::jsonb` })
        .where(eq(contentCases.id, caseId));
    },
    async setStatus(caseId, status) {
      await db.update(contentCases).set({ status }).where(eq(contentCases.id, caseId));
    },
    async mergeSnapshot(caseId, patch) {
      await db
        .update(contentCases)
        .set({ snapshot: sql`coalesce(${contentCases.snapshot}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(contentCases.id, caseId));
    },
    async upsertBlock(block) {
      // The first block of a hash keeps its provenance; a second takedown of the
      // same hash changes nothing here, the hash is already refused everywhere.
      await db.insert(contentBlocks).values(block).onConflictDoNothing({ target: contentBlocks.contentHash });
    },
    collectReferences: collectContentReferences,
  };
}

/** Thrown when an open CSAM case is re-filed under a different category. */
export class CaseCategoryDowngradeError extends Error {
  constructor(readonly caseId: string) {
    super('This content has an open CSAM case; it cannot be re-filed under another category.');
    this.name = 'CaseCategoryDowngradeError';
  }
}

export interface OpenTakedownCaseInput {
  targetType: ContentCaseTargetType;
  targetId: string;
  contentHash?: string | null;
  category: ContentBlockCategory;
  reason: string;
  takedown: TakedownOptions;
  snapshot?: Partial<ContentCaseSnapshot>;
}

export interface OpenedCase {
  case: ContentCase;
  /** False when an unfinished case for the same target and action was reused. */
  created: boolean;
}

/**
 * Open the case for a takedown, or return the one already open for the same
 * target and action so a repeated request continues it instead of starting a
 * second sequence. A reused case keeps `suspendUploader` once asked for, and
 * takes `skipPreservation` from the latest request (so a skip can be withdrawn).
 *
 * It also takes the new request's CATEGORY. The category decides whether
 * preservation may be skipped, so a case first filed as malware with
 * "skip preservation" and then re-filed as CSAM must run under the CSAM rule,
 * not the one it was opened with. The reverse is refused: a CSAM case cannot be
 * re-filed under another category (`CaseCategoryDowngradeError`).
 */
export async function openTakedownCase(input: OpenTakedownCaseInput): Promise<OpenedCase> {
  const [existing] = await db
    .select()
    .from(contentCases)
    .where(
      and(
        eq(contentCases.targetType, input.targetType),
        eq(contentCases.targetId, input.targetId),
        inArray(contentCases.status, ['open', 'awaiting_evidence']),
        takedownKindIs(input.takedown.kind),
      ),
    )
    .orderBy(desc(contentCases.createdAt))
    .limit(1);

  if (existing) {
    // A case that is CSAM stays CSAM. Re-filing it under a category that allows
    // "skip preservation" would be a way to delete it unpreserved.
    if (existing.category === 'csam' && input.category !== 'csam') {
      throw new CaseCategoryDowngradeError(existing.id);
    }
    const previous = existing.snapshot?.takedown;
    const merged: TakedownOptions = {
      ...previous,
      ...input.takedown,
      // The latest request decides whether preservation is skipped, so a skip can be withdrawn.
      skipPreservation: input.takedown.skipPreservation === true,
      skipPreservationReason: input.takedown.skipPreservation === true ? input.takedown.skipPreservationReason : undefined,
      suspendUploader: previous?.suspendUploader === true || input.takedown.suspendUploader === true,
    };
    const [updated] = await db
      .update(contentCases)
      .set({
        category: input.category,
        snapshot: sql`coalesce(${contentCases.snapshot}, '{}'::jsonb) || ${JSON.stringify({ takedown: merged })}::jsonb`,
      })
      .where(eq(contentCases.id, existing.id))
      .returning();
    return { case: updated, created: false };
  }

  const [created] = await db
    .insert(contentCases)
    .values({
      targetType: input.targetType,
      targetId: input.targetId,
      contentHash: input.contentHash ?? null,
      category: input.category,
      reason: input.reason,
      status: 'open',
      snapshot: { ...input.snapshot, takedown: input.takedown },
      steps: [],
    })
    .returning();
  return { case: created, created: true };
}

export interface ListCasesOptions {
  status?: ContentCaseStatus;
  limit?: number;
  offset?: number;
}

export async function listContentCases(options: ListCasesOptions = {}): Promise<ContentCase[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return db
    .select()
    .from(contentCases)
    .where(options.status ? eq(contentCases.status, options.status) : undefined)
    .orderBy(desc(contentCases.createdAt))
    .limit(limit)
    .offset(Math.max(options.offset ?? 0, 0));
}

export async function getContentCase(caseId: string): Promise<ContentCase | null> {
  const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId)).limit(1);
  return row ?? null;
}

/** Every case about a target: by its own ID, or by the content hash it resolves to. */
export async function listCasesForTarget(input: {
  targetType: ContentCaseTargetType;
  targetId: string;
  contentHash?: string | null;
}): Promise<ContentCase[]> {
  const byTarget = and(eq(contentCases.targetType, input.targetType), eq(contentCases.targetId, input.targetId));
  return db
    .select()
    .from(contentCases)
    .where(input.contentHash ? or(byTarget, eq(contentCases.contentHash, input.contentHash)) : byTarget)
    .orderBy(desc(contentCases.createdAt))
    .limit(100);
}

/**
 * Global takedowns due a pass over storage, for the re-sweep cron. A presigned
 * PUT issued before a block outlives it, so each finished case gets a pass once
 * that window has closed (`quietBefore`).
 *
 * Due means: finished and never swept, OR left `open` by a re-sweep that
 * failed — in both cases with fewer than `maxAttempts` passes so far, and not
 * touched since `quietBefore` (which also spaces retries apart). A case whose
 * last pass completed (`resweep.done`) is not due again.
 */
export async function listCasesDueForResweep(input: {
  quietBefore: Date;
  notOlderThan: Date;
  maxAttempts: number;
  limit?: number;
}): Promise<ContentCase[]> {
  const attempts = sql`coalesce((${contentCases.snapshot} -> 'resweep' ->> 'attempts')::int, 0)`;
  return db
    .select()
    .from(contentCases)
    .where(
      and(
        takedownKindIs('global'),
        lte(contentCases.updatedAt, input.quietBefore),
        gte(contentCases.updatedAt, input.notOlderThan),
        sql`${attempts} < ${input.maxAttempts}`,
        sql`coalesce(${contentCases.snapshot} -> 'resweep' ->> 'done', 'false') <> 'true'`,
        or(eq(contentCases.status, 'actioned'), and(eq(contentCases.status, 'open'), sql`${attempts} > 0`)),
      ),
    )
    .orderBy(contentCases.updatedAt)
    .limit(input.limit ?? 25);
}

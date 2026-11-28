/**
 * Content cases — the database edge for takedowns: open a case, record its
 * steps, write the block, and read cases back for the admin console.
 *
 * While a case runs, `steps` and `snapshot` are only ever appended to or merged
 * in SQL, never read-modified-written, so two runs of the same case cannot lose
 * each other's entries. Reopening a case merges its options in code first, and
 * does so holding the case's run lock, so it never lands while a run is under way.
 */

import { withAdvisoryLock, withBlockingAdvisoryLock } from '@pagespace/db/advisory-lock';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
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
import { collectAiMessageReferences, collectContentReferences } from './references';
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
      // One exception: a hash later found to be CSAM is marked CSAM for good.
      // The block row is what a later request is checked against, so a hash that
      // was first blocked as malware must not stay "malware" once it is CSAM.
      const insert = db.insert(contentBlocks).values(block);
      if (block.category === 'csam') {
        await insert.onConflictDoUpdate({ target: contentBlocks.contentHash, set: { category: 'csam' } });
      } else {
        await insert.onConflictDoNothing({ target: contentBlocks.contentHash });
      }
    },
    collectReferences: collectContentReferences,
    collectAiReferences: (contentHash) => collectAiMessageReferences(contentHash, { extendedTimeout: true }),
    withCaseLock: withContentCaseRunLock,
  };
}

/**
 * Run `fn` holding a case's run lock: a Postgres session advisory lock, so it
 * serialises runs across every web instance and the cron, and a crashed run's
 * lock goes with its connection. It is held on the dedicated lock pool, never
 * on a connection the run's own queries need. A run that cannot take the lock
 * at once does not wait: it is told another run is under way.
 */
const caseRunLockKey = (caseId: string) => `content_case_run:${caseId}`;

export async function withContentCaseRunLock<T>(
  caseId: string,
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const locked = await withAdvisoryLock(getAdvisoryLockPool(), caseRunLockKey(caseId), fn);
  if (locked.outcome === 'lock_busy') return { acquired: false };
  if (locked.outcome === 'connection_error') throw locked.error;
  return { acquired: true, value: locked.result };
}

/** Thrown when content with an open CSAM case, or a hash blocked as CSAM, is re-filed under a different category. */
export class CaseCategoryDowngradeError extends Error {
  constructor(readonly caseId: string) {
    super('This content is recorded as CSAM; it cannot be re-filed under another category.');
    this.name = 'CaseCategoryDowngradeError';
  }
}

/**
 * Thrown when a re-file waited for a run of the case to finish and the run outlasted the wait, or when
 * another request for the same target held the open lock past it. Nothing was changed.
 */
export class CaseRunInProgressError extends Error {
  constructor(
    readonly caseId: string,
    message = 'This case is running a takedown now. Nothing was changed; try again when the run has finished.',
  ) {
    super(message);
    this.name = 'CaseRunInProgressError';
  }
}

/** How long a re-file waits for a run of the case to finish. It is part of an admin's request, so it stays short. */
export const REFILE_LOCK_TIMEOUT_MS = 10_000;

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
 *
 * A re-file takes the case's run lock, WAITING for it (up to `lockTimeoutMs`),
 * the same lock a run holds from its first read to its last write. So a new
 * category or a withdrawn skip lands before a run or after it, never between a
 * run's read of the case and a delete it decided on. A run that outlasts the
 * wait gets `CaseRunInProgressError`, and the case is left as it was.
 *
 * Opening itself is serialised per target and kind by a second advisory lock,
 * so concurrent first requests continue ONE case rather than each inserting
 * one. (A unique partial index would also do it, but a migration adding one
 * fails on any duplicates already in the table.)
 */
export async function openTakedownCase(
  input: OpenTakedownCaseInput,
  { lockTimeoutMs = REFILE_LOCK_TIMEOUT_MS }: { lockTimeoutMs?: number } = {},
): Promise<OpenedCase> {
  // A hash once blocked as CSAM is CSAM for every later case, finished or not:
  // a new malware case with "skip preservation" must not be a way to delete
  // late-arriving copies of it unpreserved.
  if (input.takedown.kind === 'global' && input.contentHash && input.category !== 'csam') {
    const [block] = await db
      .select({ category: contentBlocks.category, caseId: contentBlocks.caseId })
      .from(contentBlocks)
      .where(eq(contentBlocks.contentHash, input.contentHash))
      .limit(1);
    if (block?.category === 'csam') throw new CaseCategoryDowngradeError(block.caseId ?? 'unknown');
  }

  // One opener per target and kind at a time. Without it, concurrent first requests each find no
  // unfinished case and each insert one: two global takedowns of the same hash, running side by side.
  const opening = await withBlockingAdvisoryLock(
    getAdvisoryLockPool(),
    caseOpenLockKey(input),
    () => openOrReuseCase(input, lockTimeoutMs),
    // Longer than the re-file's own wait inside, so a re-file that waits out a run is not cut short here.
    { timeoutMs: lockTimeoutMs + OPEN_LOCK_SLACK_MS },
  );
  if (opening.outcome === 'lock_busy') {
    throw new CaseRunInProgressError('pending', 'Another request for this target is being handled now. Nothing was changed; try again in a moment.');
  }
  if (opening.outcome === 'connection_error') throw opening.error;
  return opening.result;
}

/** Serialises opening a case for one target and takedown kind. A run never takes it, so it cannot deadlock with the run lock. */
const caseOpenLockKey = (input: OpenTakedownCaseInput) =>
  `content_case_open:${input.targetType}:${input.targetId}:${input.takedown.kind}`;
const OPEN_LOCK_SLACK_MS = 5_000;

/** Find the unfinished case for the target and re-file it, or open one. Called holding the target's open lock. */
async function openOrReuseCase(input: OpenTakedownCaseInput, lockTimeoutMs: number): Promise<OpenedCase> {
  const unfinished = and(
    eq(contentCases.targetType, input.targetType),
    eq(contentCases.targetId, input.targetId),
    inArray(contentCases.status, ['open', 'awaiting_evidence']),
    takedownKindIs(input.takedown.kind),
  );

  for (;;) {
    const [found] = await db.select({ id: contentCases.id }).from(contentCases).where(unfinished).orderBy(desc(contentCases.createdAt)).limit(1);
    if (!found) break;

    const locked = await withBlockingAdvisoryLock(
      getAdvisoryLockPool(),
      caseRunLockKey(found.id),
      async () => {
        // Read again under the lock: the run just waited for may have changed it, or finished it.
        const [existing] = await db.select().from(contentCases).where(and(eq(contentCases.id, found.id), unfinished)).limit(1);
        return existing ? refile(existing, input) : null;
      },
      { timeoutMs: lockTimeoutMs },
    );
    if (locked.outcome === 'lock_busy') throw new CaseRunInProgressError(found.id);
    if (locked.outcome === 'connection_error') throw locked.error;
    if (locked.result) return { case: locked.result, created: false };
    // The run finished the case while this waited: look again, and open a new one if none is left.
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

/** Apply a re-file to an unfinished case. Called holding the case's run lock. */
async function refile(existing: ContentCase, input: OpenTakedownCaseInput): Promise<ContentCase> {
  // A case that is CSAM stays CSAM. Re-filing it under a category that allows
  // "skip preservation" would be a way to delete it unpreserved.
  if (existing.category === 'csam' && input.category !== 'csam') {
    throw new CaseCategoryDowngradeError(existing.id);
  }
  // The block step has usually already run for a reused case, so upgrade the
  // block row here when the case becomes CSAM.
  if (input.category === 'csam' && existing.category !== 'csam' && input.contentHash) {
    await db.update(contentBlocks).set({ category: 'csam' }).where(eq(contentBlocks.contentHash, existing.contentHash ?? input.contentHash));
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
  return updated;
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

/**
 * Unfinished global takedowns touched within the window, newest first, for the re-sweep cron's public
 * pass (`sweepPublicIfUnfinished`, which skips one whose block is not written yet). A publish in flight
 * when a hash is blocked lands minutes after the block, so the newest cases matter most and a day is
 * ample; the pass records nothing when it finds nothing, so a case that stays quiet ages out of the window.
 */
export async function listUnfinishedGlobalCases(input: { notOlderThan: Date; limit?: number }): Promise<ContentCase[]> {
  return db
    .select()
    .from(contentCases)
    .where(
      and(
        takedownKindIs('global'),
        inArray(contentCases.status, ['open', 'awaiting_evidence']),
        gte(contentCases.updatedAt, input.notOlderThan),
      ),
    )
    .orderBy(desc(contentCases.updatedAt))
    .limit(input.limit ?? 200);
}

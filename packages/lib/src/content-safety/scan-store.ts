/**
 * Scan verdicts and flagged-scan cases — the database edge of the publish gate.
 *
 * `content_scans` holds the latest verdict per hash. A classifier flag opens a
 * case in the same review queue reports use (status `reported`, one per
 * target), so a flag and a user report about the same bytes land on one case.
 * Nothing here blocks, unpublishes or deletes.
 */

import { db } from '@pagespace/db/db';
import { and, count, eq, gte, inArray, lte, or, sql } from '@pagespace/db/operators';
import { DEFAULT_VERDICT_TTL_DAYS } from './scan-mode';
import {
  contentBlocks,
  contentCases,
  contentScans,
  type ContentCase,
  type ContentCaseSnapshot,
  type ContentScanMode,
  type ContentScanOutcome,
  type ContentScanVerdict,
} from '@pagespace/db/schema/content-safety';
import type { StoredVerdict, VerdictRecord } from './publish-gate';
import { isVideoContentType } from './scan-policy';

type VerdictRow = Pick<typeof contentScans.$inferSelect, 'verdict' | 'outcome' | 'scannedAt' | 'scores'>;

function toStoredVerdict(row: VerdictRow): StoredVerdict {
  const media = row.scores?.media;
  return {
    verdict: row.verdict,
    outcome: row.outcome,
    scannedAt: row.scannedAt,
    ...(row.verdict === 'unscanned' && (media === 'unscanned_allowed' || media === 'never_promote')
      ? { unscannedAllowed: media === 'unscanned_allowed' }
      : {}),
    ...(row.verdict === 'clean' && row.scores?.classifier === false && isVideoContentType(row.scores.contentType)
      ? { unclassifiedVideo: true as const }
      : {}),
  };
}

export async function findScanVerdict(contentHash: string): Promise<StoredVerdict | null> {
  const [row] = await db
    .select({ verdict: contentScans.verdict, outcome: contentScans.outcome, scannedAt: contentScans.scannedAt, scores: contentScans.scores })
    .from(contentScans)
    .where(eq(contentScans.contentHash, contentHash))
    .limit(1);
  return row ? toStoredVerdict(row) : null;
}

/** The stored verdicts of many hashes at once (the backfill's dry run). */
export async function findScanVerdicts(contentHashes: string[]): Promise<Map<string, StoredVerdict>> {
  const found = new Map<string, StoredVerdict>();
  for (let i = 0; i < contentHashes.length; i += 500) {
    const rows = await db
      .select({ contentHash: contentScans.contentHash, verdict: contentScans.verdict, outcome: contentScans.outcome, scannedAt: contentScans.scannedAt, scores: contentScans.scores })
      .from(contentScans)
      .where(inArray(contentScans.contentHash, contentHashes.slice(i, i + 500)));
    for (const row of rows) found.set(row.contentHash, toStoredVerdict(row));
  }
  return found;
}

/** Shadow-mode verdicts recorded since `since`, by outcome: what enforce would have held. Counts only. */
export async function countShadowOutcomesSince(since: Date): Promise<Array<{ outcome: ContentScanOutcome | null; count: number }>> {
  const rows = await db
    .select({ outcome: contentScans.outcome, count: count() })
    .from(contentScans)
    .where(and(eq(contentScans.mode, 'shadow'), gte(contentScans.scannedAt, since)))
    .groupBy(contentScans.outcome);
  return rows.map((row) => ({ outcome: row.outcome, count: Number(row.count) }));
}

/** The case under review (`reported`) for a hash, if one is open. */
export async function findOpenReviewCaseId(contentHash: string): Promise<string | null> {
  const [row] = await db
    .select({ id: contentCases.id })
    .from(contentCases)
    .where(and(eq(contentCases.targetType, 'content_hash'), eq(contentCases.targetId, contentHash), eq(contentCases.status, 'reported')))
    .limit(1);
  return row?.id ?? null;
}

/** Flagged-scan cases nobody has reviewed yet (still `reported`). */
export async function countOpenScanFlaggedCases(): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(contentCases)
    .where(and(eq(contentCases.status, 'reported'), sql`${contentCases.snapshot} -> 'scan' ->> 'source' = 'scan_flagged'`));
  return Number(row?.count ?? 0);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Whether the write stood (false: a standing classifier flag was kept instead). */
async function upsertVerdict(executor: typeof db | Tx, record: VerdictRecord, now: Date, keepFlagSince?: Date): Promise<boolean> {
  const values = {
    verdict: record.verdict,
    outcome: record.outcome,
    provider: record.provider,
    mode: record.mode,
    scores: record.scores,
    scannedAt: now,
  };
  // A hash match stands while its hash is blocked: a scan that started before the block (a backfill tick that
  // outlived its lease, a publish in flight) cannot erase the match. Once staff lift the block, the next scan is
  // recorded. Only another hash match replaces one.
  const keepHashMatch =
    record.outcome === 'hash_match'
      ? undefined
      : or(
          sql`${contentScans.outcome} is distinct from 'hash_match'`,
          sql`not exists (select 1 from ${contentBlocks} where ${contentBlocks.contentHash} = ${contentScans.contentHash})`,
        );
  // A classifier flag stands while it is fresh, or while a case on its hash is under review. The freshness
  // test runs on the locked row, so a concurrent flag that committed first is always seen; the case test
  // covers a flag older than the TTL whose case nobody has closed.
  const keepFlag = keepFlagSince
    ? or(
        sql`${contentScans.outcome} is distinct from 'classifier_flag'`,
        and(
          lte(contentScans.scannedAt, keepFlagSince),
          sql`not exists (select 1 from ${contentCases} where ${contentCases.contentHash} = ${contentScans.contentHash} and ${contentCases.status} = 'reported')`,
        ),
      )
    : undefined;
  const setWhere = keepHashMatch && keepFlag ? and(keepHashMatch, keepFlag) : (keepHashMatch ?? keepFlag);
  const written = await executor
    .insert(contentScans)
    .values({ contentHash: record.contentHash, ...values })
    .onConflictDoUpdate({ target: contentScans.contentHash, set: values, ...(setWhere ? { setWhere } : {}) })
    .returning({ contentHash: contentScans.contentHash });
  return written.length > 0;
}

const DEFAULT_FLAG_TTL_MS = DEFAULT_VERDICT_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * The latest verdict for a hash replaces the previous one, except a standing classifier flag: one that is fresh,
 * or whose case is still under review. That stands until a dismissal records the hash clean
 * (`closeReportedCase`) or a hash match replaces it. Two publishes of one hash can scan at once; a clean or
 * failed result from one must not undo the other's flag. `keptFlag` tells the gate its result lost to a flag,
 * so it holds the file. A classifier flag itself goes through `openScanReviewCase`.
 */
export async function recordScanVerdict(
  record: VerdictRecord,
  { now = new Date(), flagTtlMs = DEFAULT_FLAG_TTL_MS }: { now?: Date; flagTtlMs?: number } = {},
): Promise<{ keptFlag: boolean }> {
  const keepFlagSince = record.outcome === 'hash_match' ? undefined : new Date(now.getTime() - flagTtlMs);
  return { keptFlag: !(await upsertVerdict(db, record, now, keepFlagSince)) };
}

/**
 * Open the review case for a flagged hash, or join the one already under
 * review for it (a report or an earlier flag), and record the flagged verdict
 * in the same transaction. The case is categorised CSAM, which puts it at the
 * top of the queue; that is a triage label, not a finding.
 *
 * The verdict is written under the case's row lock, the lock a close takes. A
 * dismissal records the hash clean under that lock too, so the two serialise:
 * either the flag lands first and the dismissal clears it, or the dismissal
 * lands first and this flag opens a new case. A flagged verdict is never left
 * behind a closed case, holding the file with nobody reviewing it.
 */
export async function openScanReviewCase(input: {
  contentHash: string;
  provider: string;
  category: string;
  score: number;
  mode: ContentScanMode;
  /** Stored on the verdict, with the case ID added. */
  scores: Record<string, unknown>;
}, now: Date = new Date()): Promise<{ caseId: string; created: boolean; firstFlag: boolean }> {
  const scan: NonNullable<ContentCaseSnapshot['scan']> = {
    source: 'scan_flagged',
    provider: input.provider,
    category: input.category,
    score: input.score,
    mode: input.mode,
    flaggedAt: now.toISOString(),
  };
  const recordFlag = (tx: Tx, caseId: string) =>
    upsertVerdict(
      tx,
      {
        contentHash: input.contentHash,
        verdict: 'flagged',
        outcome: 'classifier_flag',
        provider: input.provider,
        mode: input.mode,
        scores: { ...input.scores, caseId },
      },
      now,
    );
  return db.transaction(async (tx) => {
    // A close can commit between the insert (which saw its case open and did nothing) and the lock (which then
    // finds no case under review). Each statement reads a fresh snapshot, so trying the insert again opens a new
    // case: the flag is never dropped, and no verdict is written outside this transaction.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [opened] = await tx
        .insert(contentCases)
        .values({
          targetType: 'content_hash',
          targetId: input.contentHash,
          contentHash: input.contentHash,
          status: 'reported',
          category: 'csam',
          reason: 'Flagged by the publish scan',
          snapshot: { scan },
          steps: [],
        })
        .onConflictDoNothing({
          target: [contentCases.targetType, contentCases.targetId],
          where: sql`${contentCases.status} = 'reported'`,
        })
        .returning({ id: contentCases.id });
      if (opened) {
        await recordFlag(tx, opened.id);
        return { caseId: opened.id, created: true, firstFlag: true };
      }

      // Lock the case under review, as a report does, and see whether it was already flagged.
      const [current] = await tx
        .select({ id: contentCases.id, snapshot: contentCases.snapshot })
        .from(contentCases)
        .where(and(eq(contentCases.targetType, 'content_hash'), eq(contentCases.targetId, input.contentHash), eq(contentCases.status, 'reported')))
        .limit(1)
        .for('update');
      if (!current) continue;
      const firstFlag = current.snapshot?.scan?.source !== 'scan_flagged';

      const [existing] = await tx
        .update(contentCases)
        .set({
          category: 'csam',
          snapshot: sql`coalesce(${contentCases.snapshot}, '{}'::jsonb) || ${JSON.stringify({ scan })}::jsonb`,
          updatedAt: now,
        })
        .where(eq(contentCases.id, current.id))
        .returning({ id: contentCases.id });
      await recordFlag(tx, existing.id);
      return { caseId: existing.id, created: false, firstFlag };
    }
    throw new Error('The case under review for this hash kept closing while a scan flag was being filed');
  });
}

/** Whether a case is one the publish scan flagged. */
export function isScanFlaggedCase(row: Pick<ContentCase, 'snapshot'>): boolean {
  return row.snapshot?.scan?.source === 'scan_flagged';
}

/** The provider a staff dismissal records (`closeReportedCase`). */
export const ADMIN_REVIEW_PROVIDER = 'admin_review';

export interface ScanVerdictCount {
  mode: ContentScanMode | null;
  outcome: ContentScanOutcome | null;
  verdict: ContentScanVerdict;
  /** Recorded by a staff review (a dismissed flag), not by the gate. */
  reviewed: boolean;
  /** Distinct contents (one verdict per hash), not files. */
  count: number;
}

/** Latest verdicts by mode, outcome and whether staff recorded them, for the admin console. Counts only. */
export async function countScanVerdicts(): Promise<ScanVerdictCount[]> {
  // The constant inline, not a parameter: the select and the group by must be the same expression.
  const reviewed = sql<boolean>`(${contentScans.provider} = ${sql.raw(`'${ADMIN_REVIEW_PROVIDER}'`)})`;
  const rows = await db
    .select({ mode: contentScans.mode, outcome: contentScans.outcome, verdict: contentScans.verdict, reviewed, count: count() })
    .from(contentScans)
    .groupBy(contentScans.mode, contentScans.outcome, contentScans.verdict, reviewed);
  return rows.map((row) => ({ ...row, reviewed: Boolean(row.reviewed), count: Number(row.count) }));
}

/**
 * Scan verdicts and flagged-scan cases — the database edge of the publish gate.
 *
 * `content_scans` holds the latest verdict per hash. A classifier flag opens a
 * case in the same review queue reports use (status `reported`, one per
 * target), so a flag and a user report about the same bytes land on one case.
 * Nothing here blocks, unpublishes or deletes.
 */

import { db } from '@pagespace/db/db';
import { and, count, eq, sql } from '@pagespace/db/operators';
import {
  contentCases,
  contentScans,
  type ContentCase,
  type ContentCaseSnapshot,
  type ContentScanMode,
  type ContentScanOutcome,
  type ContentScanVerdict,
} from '@pagespace/db/schema/content-safety';
import type { StoredVerdict, VerdictRecord } from './publish-gate';

export async function findScanVerdict(contentHash: string): Promise<StoredVerdict | null> {
  const [row] = await db
    .select({ verdict: contentScans.verdict, outcome: contentScans.outcome, scannedAt: contentScans.scannedAt, scores: contentScans.scores })
    .from(contentScans)
    .where(eq(contentScans.contentHash, contentHash))
    .limit(1);
  if (!row) return null;
  const media = row.scores?.media;
  return {
    verdict: row.verdict,
    outcome: row.outcome,
    scannedAt: row.scannedAt,
    ...(row.verdict === 'unscanned' && (media === 'unscanned_allowed' || media === 'never_promote')
      ? { unscannedAllowed: media === 'unscanned_allowed' }
      : {}),
  };
}

/** The latest verdict for a hash replaces the previous one. */
export async function recordScanVerdict(record: VerdictRecord, now: Date = new Date()): Promise<void> {
  const values = {
    verdict: record.verdict,
    outcome: record.outcome,
    provider: record.provider,
    mode: record.mode,
    scores: record.scores,
    scannedAt: now,
  };
  await db
    .insert(contentScans)
    .values({ contentHash: record.contentHash, ...values })
    .onConflictDoUpdate({ target: contentScans.contentHash, set: values });
}

/**
 * Open the review case for a flagged hash, or join the one already under
 * review for it (a report or an earlier flag). The case is categorised CSAM,
 * which puts it at the top of the queue; that is a triage label, not a finding.
 */
export async function openScanReviewCase(input: {
  contentHash: string;
  provider: string;
  category: string;
  score: number;
  mode: ContentScanMode;
}, now: Date = new Date()): Promise<{ caseId: string; created: boolean; firstFlag: boolean }> {
  const scan: NonNullable<ContentCaseSnapshot['scan']> = {
    source: 'scan_flagged',
    provider: input.provider,
    category: input.category,
    score: input.score,
    mode: input.mode,
    flaggedAt: now.toISOString(),
  };
  return db.transaction(async (tx) => {
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
    if (opened) return { caseId: opened.id, created: true, firstFlag: true };

    // Lock the case under review, as a report does, and see whether it was already flagged.
    const [current] = await tx
      .select({ id: contentCases.id, snapshot: contentCases.snapshot })
      .from(contentCases)
      .where(and(eq(contentCases.targetType, 'content_hash'), eq(contentCases.targetId, input.contentHash), eq(contentCases.status, 'reported')))
      .limit(1)
      .for('update');
    if (!current) throw new Error('The case under review for this hash closed while a scan flag was being filed');
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
    return { caseId: existing.id, created: false, firstFlag };
  });
}

/** Whether a case is one the publish scan flagged. */
export function isScanFlaggedCase(row: Pick<ContentCase, 'snapshot'>): boolean {
  return row.snapshot?.scan?.source === 'scan_flagged';
}

export interface ScanVerdictCount {
  mode: ContentScanMode | null;
  outcome: ContentScanOutcome | null;
  verdict: ContentScanVerdict;
  count: number;
}

/** Latest verdicts by mode and outcome, for the admin console. Counts only. */
export async function countScanVerdicts(): Promise<ScanVerdictCount[]> {
  const rows = await db
    .select({ mode: contentScans.mode, outcome: contentScans.outcome, verdict: contentScans.verdict, count: count() })
    .from(contentScans)
    .groupBy(contentScans.mode, contentScans.outcome, contentScans.verdict);
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

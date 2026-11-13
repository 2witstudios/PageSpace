/**
 * The scan store against REAL Postgres: verdicts upsert by hash, a flag opens a
 * case in the review queue (or joins the one already there), and counts group
 * by mode and outcome.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { contentCases, contentReports, contentScans } from '@pagespace/db/schema/content-safety';
import { countScanVerdicts, findScanVerdict, openScanReviewCase, recordReviewedClean, recordScanVerdict } from '../scan-store';
import { fileContentReport, listReportedCases } from '../report-store';

const hashes: string[] = [];
const newHash = () => {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  hashes.push(hash);
  return hash;
};

afterAll(async () => {
  if (hashes.length === 0) return;
  const cases = await db.select({ id: contentCases.id }).from(contentCases).where(inArray(contentCases.targetId, hashes));
  if (cases.length > 0) await db.delete(contentReports).where(inArray(contentReports.caseId, cases.map((c) => c.id)));
  await db.delete(contentCases).where(inArray(contentCases.targetId, hashes));
  await db.delete(contentScans).where(inArray(contentScans.contentHash, hashes));
});

describe('scan store', () => {
  it('records and replaces the latest verdict for a hash', async () => {
    const hash = newHash();
    await recordScanVerdict({ contentHash: hash, verdict: 'error', outcome: 'error', provider: 'hive', mode: 'shadow', scores: { reason: 'timeout' } }, new Date('2026-11-01T00:00:00Z'));
    await recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'shadow', scores: {} }, new Date('2026-11-02T00:00:00Z'));
    expect(await findScanVerdict(hash)).toEqual({ verdict: 'clean', outcome: 'clean', scannedAt: new Date('2026-11-02T00:00:00Z') });
    expect(await findScanVerdict(newHash())).toBeNull();
  });

  it('a flag opens a CSAM-category case in the review queue, and a second flag joins it', async () => {
    const hash = newHash();
    const first = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'shadow' });
    const second = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.97, mode: 'shadow' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ caseId: first.caseId, created: false });

    const listed = (await listReportedCases({ limit: 200 })).find((c) => c.case.id === first.caseId);
    expect(listed).toBeDefined();
    expect(listed?.reportCount).toBe(0);
    expect(listed?.case).toMatchObject({ targetType: 'content_hash', targetId: hash, category: 'csam', status: 'reported' });
    expect(listed?.case.snapshot?.scan).toMatchObject({ source: 'scan_flagged', score: 0.97, mode: 'shadow' });
  });

  it('a flag joins a case a user report already opened for the same hash', async () => {
    const hash = newHash();
    const reported = await fileContentReport({
      target: { targetType: 'content_hash', targetId: hash, contentHash: hash },
      category: 'other',
      description: null,
      source: 'anonymous',
      reporterUserId: null,
      contactEmail: null,
    });
    const flagged = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.99, mode: 'enforce' });
    expect(flagged).toEqual({ caseId: reported.caseId, created: false });
  });

  it('an admin review records the hash clean', async () => {
    const hash = newHash();
    await recordScanVerdict({ contentHash: hash, verdict: 'flagged', outcome: 'classifier_flag', provider: 'hive', mode: 'enforce', scores: {} });
    await recordReviewedClean(hash, 'admin-1');
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'clean', outcome: 'clean' });
  });

  it('counts verdicts by mode and outcome', async () => {
    const hash = newHash();
    await recordScanVerdict({ contentHash: hash, verdict: 'unscanned', outcome: 'unsupported_type', provider: 'hive', mode: 'enforce', scores: {} });
    const counts = await countScanVerdicts();
    const row = counts.find((c) => c.mode === 'enforce' && c.outcome === 'unsupported_type' && c.verdict === 'unscanned');
    expect(row?.count).toBeGreaterThanOrEqual(1);
  });
});

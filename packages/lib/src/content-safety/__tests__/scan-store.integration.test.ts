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
import { countScanVerdicts, findScanVerdict, openScanReviewCase, recordScanVerdict } from '../scan-store';
import { closeReportedCase, fileContentReport, listReportedCases, ReportedCaseChangedError } from '../report-store';

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
    const first = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'shadow', scores: {} });
    const second = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.97, mode: 'shadow', scores: {} });
    expect(first).toMatchObject({ created: true, firstFlag: true });
    expect(second).toEqual({ caseId: first.caseId, created: false, firstFlag: false });

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
    const flagged = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.99, mode: 'enforce', scores: {} });
    // The report's case had no flag: this is its first, so the gate alerts.
    expect(flagged).toEqual({ caseId: reported.caseId, created: false, firstFlag: true });
  });

  it('a flag records its verdict with its case, naming the case, in one write', async () => {
    const hash = newHash();
    const opened = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: { score: 0.95 } });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag' });
    const [row] = await db.select({ scores: contentScans.scores, mode: contentScans.mode }).from(contentScans).where(inArray(contentScans.contentHash, [hash]));
    expect(row).toEqual({ mode: 'enforce', scores: { score: 0.95, caseId: opened.caseId } });
  });

  it('a dismissal stays clean: a flag that lands after it opens a new case instead of re-flagging the closed one', async () => {
    const hash = newHash();
    const first = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });
    const [listed] = (await listReportedCases({ limit: 200 })).filter((c) => c.case.id === first.caseId);
    await closeReportedCase({
      caseId: first.caseId, outcome: 'dismissed', actorUserId: 'admin-1', expectedReportCount: 0,
      expectedScanFlaggedAt: listed.case.snapshot?.scan?.flaggedAt ?? null,
    });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'clean' });

    // A scan that started before the dismissal and finishes after it: its flag never lands without a case under review.
    const late = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.96, mode: 'enforce', scores: {} });
    expect(late).toMatchObject({ created: true, firstFlag: true });
    expect(late.caseId).not.toBe(first.caseId);
    expect((await listReportedCases({ limit: 200 })).some((c) => c.case.id === late.caseId)).toBe(true);
  });

  it('remembers whether an unscanned file was allowed', async () => {
    const hash = newHash();
    await recordScanVerdict({ contentHash: hash, verdict: 'unscanned', outcome: 'unsupported_type', provider: 'hive', mode: 'enforce', scores: { media: 'unscanned_allowed' } });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'unscanned', unscannedAllowed: true });
  });

  it('dismissing a flagged case records the hash clean in the same close', async () => {
    const hash = newHash();
    const opened = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });
    const [listed] = (await listReportedCases({ limit: 200 })).filter((c) => c.case.id === opened.caseId);
    const flaggedAt = listed.case.snapshot?.scan?.flaggedAt ?? null;

    await closeReportedCase({ caseId: opened.caseId, outcome: 'dismissed', actorUserId: 'admin-1', expectedReportCount: 0, expectedScanFlaggedAt: flaggedAt });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'clean', outcome: 'clean' });
  });

  it('refuses a dismissal when a scan flag joined after the admin looked, and clears nothing', async () => {
    const hash = newHash();
    const reported = await fileContentReport({
      target: { targetType: 'content_hash', targetId: hash, contentHash: hash },
      category: 'other',
      description: 'spam',
      source: 'anonymous',
      reporterUserId: null,
      contactEmail: null,
    });
    // The admin opens the one-report case (no flag)... then the publish gate flags the hash.
    await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.98, mode: 'shadow', scores: {} });

    await expect(
      closeReportedCase({ caseId: reported.caseId, outcome: 'dismissed', actorUserId: 'admin-1', expectedReportCount: 1, expectedScanFlaggedAt: null }),
    ).rejects.toBeInstanceOf(ReportedCaseChangedError);
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged' });
  });

  it('closing an ordinary report never writes a verdict', async () => {
    const hash = newHash();
    const reported = await fileContentReport({
      target: { targetType: 'content_hash', targetId: hash, contentHash: hash },
      category: 'other',
      description: null,
      source: 'anonymous',
      reporterUserId: null,
      contactEmail: null,
    });
    await closeReportedCase({ caseId: reported.caseId, outcome: 'dismissed', actorUserId: 'admin-1', expectedReportCount: 1 });
    expect(await findScanVerdict(hash)).toBeNull();
  });

  it('counts verdicts by mode and outcome', async () => {
    const hash = newHash();
    await recordScanVerdict({ contentHash: hash, verdict: 'unscanned', outcome: 'unsupported_type', provider: 'hive', mode: 'enforce', scores: {} });
    const counts = await countScanVerdicts();
    const row = counts.find((c) => c.mode === 'enforce' && c.outcome === 'unsupported_type' && c.verdict === 'unscanned');
    expect(row?.count).toBeGreaterThanOrEqual(1);
  });
});

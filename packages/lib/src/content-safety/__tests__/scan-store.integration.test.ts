/**
 * The scan store against REAL Postgres: verdicts upsert by hash, a flag opens a
 * case in the review queue (or joins the one already there), and counts group
 * by mode and outcome.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
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
    await recordScanVerdict({ contentHash: hash, verdict: 'error', outcome: 'error', provider: 'hive', mode: 'shadow', scores: { reason: 'timeout' } }, { now: new Date('2026-11-01T00:00:00Z') });
    await recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'shadow', scores: {} }, { now: new Date('2026-11-02T00:00:00Z') });
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

  it('a dismissal that commits while a flag waits on the case lock does not lose the flag: it opens a new case', async () => {
    const hash = newHash();
    const first = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });

    // The admin's close holds the case row lock. The flag's insert sees the committed open case and does nothing,
    // then waits on that lock; the close commits the case dismissed and the hash clean.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    let closePid = 0;
    const close = db.transaction(async (tx) => {
      const pid = await tx.execute(sql`select pg_backend_pid() as pid`);
      closePid = Number((pid.rows[0] as { pid: number }).pid);
      await tx.select({ id: contentCases.id }).from(contentCases).where(eq(contentCases.id, first.caseId)).for('update');
      locked();
      await held;
      await tx.update(contentCases).set({ status: 'dismissed' }).where(eq(contentCases.id, first.caseId));
      const clean = { verdict: 'clean' as const, outcome: 'clean' as const, provider: 'admin_review', mode: null, scores: {}, scannedAt: new Date() };
      await tx.insert(contentScans).values({ contentHash: hash, ...clean }).onConflictDoUpdate({ target: contentScans.contentHash, set: clean });
    });
    await isLocked;
    const late = openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.96, mode: 'enforce', scores: {} });
    // Wait until the flag is blocked by THIS close's lock, so the close commits between its insert and its lock.
    let blocked = false;
    for (let i = 0; i < 250 && !blocked; i++) {
      const waiting = await db.execute(sql`select 1 from pg_stat_activity where ${closePid} = any(pg_blocking_pids(pid))`);
      blocked = waiting.rows.length > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);
    release();
    await close;

    const flagged = await late;
    expect(flagged).toMatchObject({ created: true, firstFlag: true });
    expect(flagged.caseId).not.toBe(first.caseId);
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag' });
  });

  it('never caches text as allowed or held: the next publish reads it and applies its own declared type', async () => {
    const hash = newHash();
    await recordScanVerdict({ contentHash: hash, verdict: 'unscanned', outcome: 'unsupported_type', provider: 'hive', mode: 'enforce', scores: { media: 'text' } });
    const stored = await findScanVerdict(hash);
    expect(stored).toMatchObject({ verdict: 'unscanned' });
    expect(stored).not.toHaveProperty('unscannedAllowed');
  });

  it('a later scan cannot overwrite a fresh classifier flag; only a dismissal, a hash match or expiry replaces it', async () => {
    const hash = newHash();
    await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });
    // A concurrent publish's scan came back clean (or failed) after the flag: the flag stands.
    await recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'enforce', scores: {} });
    await recordScanVerdict({ contentHash: hash, verdict: 'error', outcome: 'error', provider: 'hive', mode: 'enforce', scores: {} });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag' });

    // Once the flag has expired, a new verdict replaces it.
    const later = new Date(Date.now() + 60_000);
    await recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'enforce', scores: {} }, { now: later, flagTtlMs: 30_000 });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'clean' });
  });

  it('a hash match replaces a fresh classifier flag', async () => {
    const hash = newHash();
    await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });
    await recordScanVerdict({ contentHash: hash, verdict: 'flagged', outcome: 'hash_match', provider: 'hive', mode: 'enforce', scores: {} });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'hash_match' });
  });

  it('counts a staff dismissal apart from a verdict with no mode', async () => {
    const hash = newHash();
    const opened = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });
    const [listed] = (await listReportedCases({ limit: 200 })).filter((c) => c.case.id === opened.caseId);
    await closeReportedCase({ caseId: opened.caseId, outcome: 'dismissed', actorUserId: 'admin-1', expectedReportCount: 0, expectedScanFlaggedAt: listed.case.snapshot?.scan?.flaggedAt ?? null });
    const counts = await countScanVerdicts();
    expect(counts.find((c) => c.reviewed && c.verdict === 'clean')?.count).toBeGreaterThanOrEqual(1);
    expect(counts.every((c) => !c.reviewed || c.mode === null)).toBe(true);
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

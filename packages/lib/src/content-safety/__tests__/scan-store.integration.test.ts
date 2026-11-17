/**
 * The scan store against REAL Postgres: verdicts upsert by hash, a flag opens a
 * case in the review queue (or joins the one already there), and counts group
 * by mode and outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { contentCases, contentReports, contentScans } from '@pagespace/db/schema/content-safety';
import { countScanVerdicts, findScanVerdict, openScanReviewCase, recordScanVerdict } from '../scan-store';
import { closeReportedCase, fileContentReport, listReportedCases, ReportedCaseChangedError } from '../report-store';
import { gatePublishAsset, type PublishGateDeps } from '../publish-gate';
import { resolveScanConfig } from '../scan-mode';
import { createFakeScanner, type ScanResult } from '../scanner';

const hashes: string[] = [];
const newHash = () => {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  hashes.push(hash);
  return hash;
};

// Dedicated connections for the lock tests, outside the app pool: one holds a lock, one watches who waits on
// it. Neither competes with the code under test for a pool connection.
let holder: Client;
let probe: Client;
beforeAll(async () => {
  holder = new Client({ connectionString: process.env.DATABASE_URL });
  probe = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await probe.connect();
});

/** Wait until some backend is blocked by `holder`'s locks. */
async function waitUntilBlockedByHolder(): Promise<boolean> {
  const pid = Number((await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid);
  for (let i = 0; i < 250; i++) {
    const waiting = await probe.query('select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [pid]);
    if (waiting.rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

afterAll(async () => {
  await holder?.end();
  await probe?.end();
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
    await holder.query('begin');
    let late: ReturnType<typeof openScanReviewCase> | undefined;
    try {
      await holder.query('select id from content_cases where id = $1 for update', [first.caseId]);
      late = openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.96, mode: 'enforce', scores: {} });
      // The flag must be blocked by THIS close's lock, so the close commits between its insert and its lock.
      expect(await waitUntilBlockedByHolder()).toBe(true);
      await holder.query(`update content_cases set status = 'dismissed' where id = $1`, [first.caseId]);
      await holder.query(
        `insert into content_scans (content_hash, verdict, outcome, provider, scores, scanned_at) values ($1, 'clean', 'clean', 'admin_review', '{}', now())
         on conflict (content_hash) do update set verdict = 'clean', outcome = 'clean', provider = 'admin_review', mode = null, scanned_at = now()`,
        [hash],
      );
      await holder.query('commit');
    } finally {
      await holder.query('rollback'); // a no-op after the commit; releases the lock if anything above failed
      await late?.catch(() => undefined);
    }

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
    // A concurrent publish's scan came back clean (or failed) after the flag: the flag stands, and the caller
    // is told, so the gate holds that publish too.
    await expect(
      recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'enforce', scores: {} }),
    ).resolves.toEqual({ keptFlag: true });
    await recordScanVerdict({ contentHash: hash, verdict: 'error', outcome: 'error', provider: 'hive', mode: 'enforce', scores: {} });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag' });

    // Past its TTL, the flag still stands while its case is under review: only staff clear it.
    const later = new Date(Date.now() + 60_000);
    await expect(
      recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'enforce', scores: {} }, { now: later, flagTtlMs: 30_000 }),
    ).resolves.toEqual({ keptFlag: true });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged' });
  });

  it('an expired flag whose case is closed is replaced by the next verdict', async () => {
    const hash = newHash();
    const opened = await openScanReviewCase({ contentHash: hash, provider: 'hive', category: 'csam', score: 0.95, mode: 'enforce', scores: {} });
    // Closed as actioned (no takedown): the flag is left, and expires like any verdict.
    await db.update(contentCases).set({ status: 'actioned' }).where(eq(contentCases.id, opened.caseId));
    const later = new Date(Date.now() + 60_000);
    await expect(
      recordScanVerdict({ contentHash: hash, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'enforce', scores: {} }, { now: later, flagTtlMs: 30_000 }),
    ).resolves.toEqual({ keptFlag: false });
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

  it('two publishes of one hash that both missed the cache: the one scanned clean after the flag is held, and the flag stands', async () => {
    const hash = newHash();
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const config = resolveScanConfig({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' }, { onPrem: false });
    const results: ScanResult[] = [
      { kind: 'classifier_flag', provider: 'fake', category: 'csam', score: 0.97 },
      { kind: 'clean', provider: 'fake' },
    ];
    const deps: PublishGateDeps = {
      config,
      scanner: createFakeScanner({ results: { [hash]: () => results.shift() ?? { kind: 'clean', provider: 'fake' } } }),
      isBlocked: async () => false,
      // Both publishes read the verdict before either recorded one.
      findVerdict: async () => null,
      readSource: async () => ({ bytes: PNG, complete: true }),
      recordVerdict: (record) => recordScanVerdict(record, { flagTtlMs: config.verdictTtlMs }),
      takedownHashMatch: async () => ({}),
      openReviewCase: (input) => openScanReviewCase(input),
      alert: async () => undefined,
      audit: () => undefined,
      reportMisconfiguration: () => undefined,
      logError: () => undefined,
      now: () => new Date(),
    };
    const input = { contentHash: hash, originalKey: `files/${hash}/original`, declaredContentType: 'image/png', fileId: 'f', userId: null, entryPoint: 'canvas_asset' as const };

    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag' });
  });

  it('a clean publish that waits on a flag being recorded for the same hash is held, and the flag stands', async () => {
    const hash = newHash();
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const config = resolveScanConfig({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' }, { onPrem: false });
    const deps: PublishGateDeps = {
      config,
      scanner: createFakeScanner({ defaultResult: { kind: 'clean', provider: 'fake' } }),
      isBlocked: async () => false,
      findVerdict: async () => null,
      readSource: async () => ({ bytes: PNG, complete: true }),
      recordVerdict: (record) => recordScanVerdict(record, { flagTtlMs: config.verdictTtlMs }),
      takedownHashMatch: async () => ({}),
      openReviewCase: (input) => openScanReviewCase(input),
      alert: async () => undefined,
      audit: () => undefined,
      reportMisconfiguration: () => undefined,
      logError: () => undefined,
      now: () => new Date(),
    };
    // The other publish's flag: its verdict row is written and locked, its transaction not yet committed.
    await holder.query('begin');
    let clean: ReturnType<typeof gatePublishAsset> | undefined;
    try {
      await holder.query(
        `insert into content_scans (content_hash, verdict, outcome, provider, mode, scores, scanned_at) values ($1, 'flagged', 'classifier_flag', 'fake', 'enforce', '{}', now())`,
        [hash],
      );
      clean = gatePublishAsset(
        { contentHash: hash, originalKey: `files/${hash}/original`, declaredContentType: 'image/png', fileId: 'f', userId: null, entryPoint: 'canvas_asset' },
        deps,
      );
      // The clean publish's verdict write must be blocked by the flag's row lock before the flag commits.
      expect(await waitUntilBlockedByHolder()).toBe(true);
      await holder.query('commit');
    } finally {
      await holder.query('rollback'); // a no-op after the commit; releases the lock if anything above failed
      await clean?.catch(() => undefined);
    }

    await expect(clean).resolves.toEqual({ promote: false, reason: 'held' });
    expect(await findScanVerdict(hash)).toMatchObject({ verdict: 'flagged', outcome: 'classifier_flag' });
  });
});

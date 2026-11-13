import { describe, expect, it, vi } from 'vitest';
import { evaluatePublishAsset, gatePublishAsset, type PublishGateDeps, type PublishGateInput, type StoredVerdict } from '../publish-gate';
import { resolveScanConfig } from '../scan-mode';
import { createFakeScanner, type ContentScanner, type ScanResult } from '../scanner';

const HASH = 'a'.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.7 ...');

const input: PublishGateInput = {
  contentHash: HASH,
  originalKey: `files/${HASH}/original`,
  declaredContentType: 'image/png',
  fileId: 'file-1',
  userId: 'user-1',
  entryPoint: 'canvas_asset',
};

function setup(options: {
  mode?: 'off' | 'shadow' | 'enforce';
  key?: boolean;
  scanner?: ContentScanner | null;
  result?: ScanResult;
  blocked?: boolean;
  verdict?: StoredVerdict | null;
  bytes?: Uint8Array;
  complete?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
} = {}) {
  const config = {
    ...resolveScanConfig(
      { CONTENT_SCAN_MODE: options.mode ?? 'enforce', HIVE_API_KEY: options.key === false ? '' : 'k', CONTENT_SCAN_TIMEOUT_MS: String(options.timeoutMs ?? 1000), ...options.env },
      { onPrem: false },
    ),
  };
  const scanner = options.scanner === undefined ? createFakeScanner({ defaultResult: options.result }) : options.scanner;
  const deps = {
    config,
    scanner: config.scannerConfigured ? scanner : null,
    isBlocked: vi.fn(async () => options.blocked ?? false),
    findVerdict: vi.fn(async () => options.verdict ?? null),
    readSource: vi.fn(async () => ({ bytes: options.bytes ?? PNG, complete: options.complete ?? true })),
    recordVerdict: vi.fn(async () => ({ keptFlag: false })),
    takedownHashMatch: vi.fn(async () => ({ caseId: 'case-td' })),
    openReviewCase: vi.fn(async () => ({ caseId: 'case-rv', created: true, firstFlag: true })),
    alert: vi.fn(async () => undefined),
    audit: vi.fn(),
    reportMisconfiguration: vi.fn(),
    logError: vi.fn(),
    now: () => new Date('2026-11-13T00:00:00Z'),
  } satisfies PublishGateDeps;
  return { deps, scanner };
}

const flag: ScanResult = { kind: 'classifier_flag', provider: 'fake', category: 'csam', score: 0.97 };
const match: ScanResult = { kind: 'hash_match', provider: 'fake', lists: ['ncmec'], matchTypes: ['CSAM'] };

describe('gatePublishAsset', () => {
  it('a blocked hash is refused in every mode, before anything else is read', async () => {
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      const { deps } = setup({ mode, blocked: true });
      await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'blocked' });
      expect(deps.findVerdict).not.toHaveBeenCalled();
      expect(deps.readSource).not.toHaveBeenCalled();
    }
  });

  it('a blocklist read failure throws (the caller holds the asset)', async () => {
    const { deps } = setup();
    deps.isBlocked.mockRejectedValueOnce(new Error('db down'));
    await expect(gatePublishAsset(input, deps)).rejects.toThrow('db down');
  });

  it('off mode promotes without scanning', async () => {
    const { deps, scanner } = setup({ mode: 'off' });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
    expect(deps.readSource).not.toHaveBeenCalled();
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([]);
  });

  it('a fresh clean verdict promotes without reading or scanning', async () => {
    const { deps } = setup({ verdict: { verdict: 'clean', outcome: 'clean', scannedAt: new Date('2026-11-01T00:00:00Z') } });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
    expect(deps.readSource).not.toHaveBeenCalled();
    expect(deps.recordVerdict).not.toHaveBeenCalled();
  });

  it('an expired clean verdict is scanned again', async () => {
    const { deps, scanner } = setup({ verdict: { verdict: 'clean', outcome: 'clean', scannedAt: new Date('2026-01-01T00:00:00Z') } });
    await gatePublishAsset(input, deps);
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([HASH]);
  });

  it('a clean scan that lost to a standing flag (another publish flagged the hash) is held under enforce', async () => {
    const enforce = setup();
    enforce.deps.recordVerdict.mockResolvedValueOnce({ keptFlag: true });
    await expect(gatePublishAsset(input, enforce.deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(enforce.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ promoted: false }) }));

    // Shadow publishes everything anyway.
    const shadow = setup({ mode: 'shadow' });
    shadow.deps.recordVerdict.mockResolvedValueOnce({ keptFlag: true });
    await expect(gatePublishAsset(input, shadow.deps)).resolves.toEqual({ promote: true });
  });

  it('clean: records the verdict, audits and promotes', async () => {
    const { deps } = setup();
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ contentHash: HASH, verdict: 'clean', outcome: 'clean', mode: 'enforce' }));
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.clean', contentHash: HASH, userId: 'user-1' }));
  });

  it('enforce holds a classifier flag, opens a review case and alerts, with no takedown', async () => {
    const { deps } = setup({ result: flag });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.openReviewCase).toHaveBeenCalledWith(expect.objectContaining({ contentHash: HASH, score: 0.97, mode: 'enforce' }));
    expect(deps.alert).toHaveBeenCalledWith({ event: 'scan_flagged', caseId: 'case-rv', category: 'csam' });
    expect(deps.takedownHashMatch).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.flagged', details: expect.objectContaining({ caseId: 'case-rv', promoted: false }) }));
  });

  it('a flag joining a case that was already flagged does not alert again', async () => {
    const { deps } = setup({ result: flag });
    deps.openReviewCase.mockResolvedValueOnce({ caseId: 'case-rv', created: false, firstFlag: false });
    await gatePublishAsset(input, deps);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('a first flag joining a case a report opened alerts', async () => {
    const { deps } = setup({ result: flag });
    deps.openReviewCase.mockResolvedValueOnce({ caseId: 'case-rep', created: false, firstFlag: true });
    await gatePublishAsset(input, deps);
    expect(deps.alert).toHaveBeenCalledWith({ event: 'scan_flagged', caseId: 'case-rep', category: 'csam' });
  });

  it('when the review case cannot be opened, the flag is not cached: an error is recorded so the next publish retries', async () => {
    const { deps } = setup({ result: flag });
    deps.openReviewCase.mockRejectedValueOnce(new Error('db down'));
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error', outcome: 'error', scores: expect.objectContaining({ reason: 'review_case_failed' }) }));
    expect(deps.recordVerdict).not.toHaveBeenCalledWith(expect.objectContaining({ verdict: 'flagged' }));
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('the flag is recorded with its case, in one write, never on its own after it', async () => {
    // A separate verdict write after the case opens could land after an admin dismissed the case and recorded the
    // hash clean, putting back a flag no open case stands behind.
    const { deps } = setup({ result: flag });
    await gatePublishAsset(input, deps);
    expect(deps.openReviewCase).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: HASH, scores: expect.objectContaining({ category: 'csam', score: 0.97 }) }),
    );
    expect(deps.recordVerdict).not.toHaveBeenCalled();
  });

  it('logs only an error name, never its message (a query error carries the hash)', async () => {
    const { deps } = setup({ result: flag });
    deps.openReviewCase.mockRejectedValueOnce(new Error(`insert failed params: ${HASH}`));
    await gatePublishAsset(input, deps);
    expect(JSON.stringify(deps.logError.mock.calls)).not.toContain(HASH);
  });

  it('a fresh unscanned verdict is not re-read: allowed promotes, never-promote holds', async () => {
    const allowed = setup({ verdict: { verdict: 'unscanned', outcome: 'unsupported_type', scannedAt: new Date('2026-11-12T00:00:00Z'), unscannedAllowed: true } });
    await expect(gatePublishAsset(input, allowed.deps)).resolves.toEqual({ promote: true });
    expect(allowed.deps.readSource).not.toHaveBeenCalled();
    const opaque = setup({ verdict: { verdict: 'unscanned', outcome: 'unsupported_type', scannedAt: new Date('2026-11-12T00:00:00Z'), unscannedAllowed: false } });
    await expect(gatePublishAsset(input, opaque.deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(opaque.deps.readSource).not.toHaveBeenCalled();
  });

  it('records text as text, not as allowed: whether text may publish depends on what each upload declares', async () => {
    // The same bytes declared as text/plain publish, declared as image/png are held: a cached "allowed" would
    // promote the second, and a cached "held" would hold a later text upload.
    const { deps } = setup({ bytes: new TextEncoder().encode('plain words, nothing more, '.repeat(4)) });
    await gatePublishAsset({ ...input, declaredContentType: 'text/plain' }, deps);
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unscanned', scores: expect.objectContaining({ media: 'text' }) }));
  });

  it('records whether an unscanned file was allowed, so the next publish can skip the read', async () => {
    const { deps } = setup({ bytes: PDF });
    await gatePublishAsset({ ...input, declaredContentType: 'application/pdf' }, deps);
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ scores: expect.objectContaining({ media: 'unscanned_allowed' }) }));
  });

  it('shadow promotes a flag but records it and opens the case exactly as enforce does', async () => {
    const { deps } = setup({ mode: 'shadow', result: flag });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
    expect(deps.openReviewCase).toHaveBeenCalledWith(expect.objectContaining({ mode: 'shadow' }));
    expect(deps.recordVerdict).not.toHaveBeenCalled();
    expect(deps.alert).toHaveBeenCalled();
  });

  it('a hash match runs the takedown and is not promoted, even in shadow mode', async () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      const { deps } = setup({ mode, result: match });
      await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
      expect(deps.takedownHashMatch).toHaveBeenCalledWith({ contentHash: HASH, lists: ['ncmec'] });
      expect(deps.openReviewCase).not.toHaveBeenCalled();
      expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.hash_match', details: expect.objectContaining({ caseId: 'case-td' }) }));
    }
  });

  it('a failed takedown still holds the file', async () => {
    const { deps } = setup({ mode: 'shadow', result: match });
    deps.takedownHashMatch.mockRejectedValueOnce(new Error('S3 down'));
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.logError).toHaveBeenCalled();
  });

  it('enforce holds a scanner error and records it so a republish retries', async () => {
    const { deps } = setup({ result: { kind: 'error', provider: 'fake', reason: 'http_status', detail: '503' } });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error', scores: expect.objectContaining({ reason: 'http_status' }) }));
  });

  it('a stored error verdict does not short-circuit: the next publish scans again', async () => {
    const { deps, scanner } = setup({ verdict: { verdict: 'error', outcome: 'error', scannedAt: new Date('2026-11-12T00:00:00Z') } });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([HASH]);
  });

  it('enforce holds on a timeout', async () => {
    const { deps } = setup({ scanner: createFakeScanner({ delayMs: 200 }), timeoutMs: 20 });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.error', details: expect.objectContaining({ reason: 'timeout' }) }));
  });

  it('a fresh classifier flag holds under enforce without rescanning or a new case', async () => {
    const { deps, scanner } = setup({ verdict: { verdict: 'flagged', outcome: 'classifier_flag', scannedAt: new Date('2026-11-12T00:00:00Z') } });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([]);
    expect(deps.openReviewCase).not.toHaveBeenCalled();
  });

  it('enforce with no vendor key fails closed and reports the problem', async () => {
    const { deps } = setup({ key: false });
    await expect(gatePublishAsset({ ...input, declaredContentType: 'application/pdf' }, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.reportMisconfiguration).toHaveBeenCalledWith('missing_key');
    expect(deps.readSource).not.toHaveBeenCalled();
  });

  it('shadow with no vendor key promotes and reports the problem', async () => {
    const { deps } = setup({ mode: 'shadow', key: false });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
    expect(deps.reportMisconfiguration).toHaveBeenCalledWith('missing_key');
  });

  it('an archive is never promoted under enforce and is not sent to the scanner', async () => {
    const { deps, scanner } = setup({ bytes: ZIP });
    await expect(gatePublishAsset({ ...input, declaredContentType: 'application/zip' }, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([]);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.unscanned' }));
  });

  it('a PDF promotes unscanned and is recorded as unscanned', async () => {
    const { deps } = setup({ bytes: PDF });
    await expect(gatePublishAsset({ ...input, declaredContentType: 'application/pdf' }, deps)).resolves.toEqual({ promote: true });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unscanned', outcome: 'unsupported_type' }));
  });

  it('a PNG declared as a PDF is scanned', async () => {
    const { deps, scanner } = setup({ result: flag });
    await expect(gatePublishAsset({ ...input, declaredContentType: 'application/pdf' }, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([HASH]);
  });

  it('an image larger than the limit is an error, not a pass', async () => {
    const { deps, scanner } = setup({ complete: false });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect((scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([]);
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error', scores: expect.objectContaining({ reason: 'too_large' }) }));
  });

  it('an audio-branded MP4 read only in part is treated as video: too large to scan, held, never published unscanned', async () => {
    const m4aHead = Uint8Array.from('\0\0\0\x14ftypM4A \0\0\0\0M4A ', (c) => c.charCodeAt(0));
    const { deps } = setup({ bytes: m4aHead, complete: false });
    await expect(gatePublishAsset({ ...input, declaredContentType: 'audio/mp4' }, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error', scores: expect.objectContaining({ reason: 'too_large' }) }));
  });

  it('a missing or unreadable original is an error', async () => {
    const { deps } = setup();
    deps.readSource.mockResolvedValueOnce(null as never);
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
  });

  it('a failed verdict write never makes the gate promote', async () => {
    const { deps } = setup({ result: flag });
    deps.openReviewCase.mockRejectedValueOnce(new Error('db down'));
    deps.recordVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.recordVerdict).toHaveBeenCalled();
  });

  it('a clean scan whose verdict cannot be recorded is held under enforce: a standing flag could not be ruled out', async () => {
    const enforce = setup();
    enforce.deps.recordVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(gatePublishAsset(input, enforce.deps)).resolves.toEqual({ promote: false, reason: 'held' });

    const shadow = setup({ mode: 'shadow' });
    shadow.deps.recordVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(gatePublishAsset(input, shadow.deps)).resolves.toEqual({ promote: true });
  });

  it('audit details carry IDs and scores only', async () => {
    const { deps } = setup({ result: flag });
    await gatePublishAsset(input, deps);
    const [event] = deps.audit.mock.calls[0] as unknown as [{ details: Record<string, unknown> }];
    expect(Object.keys(event.details).sort()).toEqual(['caseId', 'contentType', 'entryPoint', 'fileId', 'mode', 'promoted', 'provider', 'score'].sort());
  });
});

describe('video with no classifier output (PR 5)', () => {
  const MP4 = Uint8Array.from('\0\0\0\x18ftypisom\0\0\0\0isommp41', (c) => c.charCodeAt(0));
  const hashOnly: ScanResult = { kind: 'clean', provider: 'fake' };
  const videoInput = { ...input, declaredContentType: 'video/mp4' };

  it('enforce holds it as unverified, not clean, and records why', async () => {
    const { deps } = setup({ bytes: MP4, result: hashOnly });
    await expect(evaluatePublishAsset(videoInput, deps)).resolves.toMatchObject({ promote: false, reason: 'held', finding: 'unverified', scanned: true });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverified', outcome: 'unverified', provider: 'fake', scores: expect.objectContaining({ classifier: false }) }));
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.unverified', details: expect.objectContaining({ promoted: false }) }));
    expect(deps.openReviewCase).not.toHaveBeenCalled();
  });

  it('shadow promotes it but records it as unverified', async () => {
    const { deps } = setup({ mode: 'shadow', bytes: MP4, result: hashOnly });
    await expect(gatePublishAsset(videoInput, deps)).resolves.toEqual({ promote: true });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverified', mode: 'shadow' }));
  });

  it('a video the classifier did score is clean', async () => {
    const { deps } = setup({ bytes: MP4, result: { kind: 'clean', provider: 'fake', scores: { csam: 0.01 } } });
    await expect(gatePublishAsset(videoInput, deps)).resolves.toEqual({ promote: true });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'clean' }));
  });

  it('an image with no classifier output keeps the old reading (clean)', async () => {
    const { deps } = setup({ result: hashOnly });
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: true });
  });

  it('CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO=true relaxes it to clean', async () => {
    const { deps } = setup({ bytes: MP4, result: hashOnly, env: { CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO: 'true' } });
    await expect(gatePublishAsset(videoInput, deps)).resolves.toEqual({ promote: true });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'clean' }));
  });

  it('a fresh unverified verdict is held without a rescan; once relaxed, it is scanned again', async () => {
    const verdict: StoredVerdict = { verdict: 'unverified', outcome: 'unverified', scannedAt: new Date('2026-11-10T00:00:00Z') };
    const held = setup({ bytes: MP4, result: hashOnly, verdict });
    await expect(evaluatePublishAsset(videoInput, held.deps)).resolves.toMatchObject({ promote: false, finding: 'unverified', scanned: false });
    expect(held.deps.readSource).not.toHaveBeenCalled();

    const relaxed = setup({ bytes: MP4, result: hashOnly, verdict, env: { CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO: 'true' } });
    await expect(gatePublishAsset(videoInput, relaxed.deps)).resolves.toEqual({ promote: true });
    expect((relaxed.scanner as ReturnType<typeof createFakeScanner>).calls).toEqual([HASH]);
  });
});

describe('evaluatePublishAsset findings', () => {
  it('reports what it found, whether it scanned, and the case', async () => {
    await expect(evaluatePublishAsset(input, setup({ blocked: true }).deps)).resolves.toMatchObject({ finding: 'blocked', scanned: false });
    await expect(evaluatePublishAsset(input, setup({ mode: 'off' }).deps)).resolves.toMatchObject({ promote: true, finding: 'off' });
    await expect(evaluatePublishAsset(input, setup({ result: flag }).deps)).resolves.toMatchObject({ finding: 'flagged', scanned: true, caseId: 'case-rv' });
    await expect(evaluatePublishAsset(input, setup({ result: match }).deps)).resolves.toMatchObject({ finding: 'hash_match', caseId: 'case-td' });
    await expect(evaluatePublishAsset(input, setup({ key: false }).deps)).resolves.toMatchObject({ finding: 'unavailable', scanned: false });
    const cached = setup({ verdict: { verdict: 'clean', outcome: 'clean', scannedAt: new Date('2026-11-01T00:00:00Z') } });
    await expect(evaluatePublishAsset(input, cached.deps)).resolves.toMatchObject({ finding: 'clean', scanned: false });
  });
});

describe('scanWithTimeout via the fake scanner', () => {
  it('returns a configured result per hash', async () => {
    const scanner = createFakeScanner({ results: { [HASH]: flag } });
    await expect(scanner.scan({ contentHash: HASH, mediaKind: 'image', contentType: 'image/png', bytes: PNG })).resolves.toEqual(flag);
    await expect(scanner.scan({ contentHash: 'b'.repeat(64), mediaKind: 'image', contentType: 'image/png', bytes: PNG })).resolves.toMatchObject({ kind: 'clean' });
  });
});

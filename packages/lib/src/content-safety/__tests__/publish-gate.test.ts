import { describe, expect, it, vi } from 'vitest';
import { gatePublishAsset, type PublishGateDeps, type PublishGateInput, type StoredVerdict } from '../publish-gate';
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
} = {}) {
  const config = {
    ...resolveScanConfig(
      { CONTENT_SCAN_MODE: options.mode ?? 'enforce', HIVE_API_KEY: options.key === false ? '' : 'k', CONTENT_SCAN_TIMEOUT_MS: String(options.timeoutMs ?? 1000) },
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
    recordVerdict: vi.fn(async () => undefined),
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

  it('a failed verdict write never changes the decision', async () => {
    const { deps } = setup({ result: flag });
    deps.openReviewCase.mockRejectedValueOnce(new Error('db down'));
    deps.recordVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(gatePublishAsset(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    expect(deps.recordVerdict).toHaveBeenCalled();
  });

  it('audit details carry IDs and scores only', async () => {
    const { deps } = setup({ result: flag });
    await gatePublishAsset(input, deps);
    const [event] = deps.audit.mock.calls[0] as unknown as [{ details: Record<string, unknown> }];
    expect(Object.keys(event.details).sort()).toEqual(['caseId', 'contentType', 'entryPoint', 'fileId', 'mode', 'promoted', 'provider', 'score'].sort());
  });
});

describe('scanWithTimeout via the fake scanner', () => {
  it('returns a configured result per hash', async () => {
    const scanner = createFakeScanner({ results: { [HASH]: flag } });
    await expect(scanner.scan({ contentHash: HASH, mediaKind: 'image', contentType: 'image/png', bytes: PNG })).resolves.toEqual(flag);
    await expect(scanner.scan({ contentHash: 'b'.repeat(64), mediaKind: 'image', contentType: 'image/png', bytes: PNG })).resolves.toMatchObject({ kind: 'clean' });
  });
});

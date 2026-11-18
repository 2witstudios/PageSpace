import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackfillTarget } from '@pagespace/lib/content-safety/backfill';
import { resolveScanConfig } from '@pagespace/lib/content-safety/scan-mode';
import { createFakeScanner, type ScanResult } from '@pagespace/lib/content-safety/scanner';
import type { StoredVerdict } from '@pagespace/lib/content-safety/publish-gate';

vi.mock('server-only', () => ({}));

const executeTakedown = vi.fn();
vi.mock('../takedown-service', () => ({ executeTakedown: (...args: unknown[]) => executeTakedown(...args) }));

const send = vi.fn();
vi.mock('@/lib/presigned-url', () => ({
  getS3Bucket: () => 'private',
  getS3Client: () => ({ send: (...args: unknown[]) => send(...args) }),
}));
const readPublishedObjectBounded = vi.fn();
vi.mock('@/lib/canvas/published-storage', () => ({
  deletePublishedAssetsForHash: vi.fn(),
  isPublishConfigured: () => true,
  listPublishedAssetsPage: vi.fn(),
  readPublishedObjectBounded: (...args: unknown[]) => readPublishedObjectBounded(...args),
}));
const readS3ObjectBounded = vi.fn();
vi.mock('@/lib/storage/s3-objects', () => ({
  listS3Page: vi.fn(),
  readS3ObjectBounded: (...args: unknown[]) => readS3ObjectBounded(...args),
}));

const securityLog = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { security: securityLog, api: securityLog } }));
const audit = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: (...args: unknown[]) => audit(...args) }));
const isHashBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({ isHashBlocked: (...args: unknown[]) => isHashBlocked(...args), findBlockCaseId: vi.fn(async () => null) }));
const findScanVerdict = vi.fn();
vi.mock('@pagespace/lib/content-safety/scan-store', () => ({
  findScanVerdict: (...args: unknown[]) => findScanVerdict(...args),
  findOpenReviewCaseId: vi.fn(async () => null),
  findScanVerdicts: vi.fn(),
  recordScanVerdict: vi.fn(async () => ({ keptFlag: false })),
  openScanReviewCase: vi.fn(async () => ({ caseId: 'case-rv', created: true, firstFlag: true })),
}));
vi.mock('@pagespace/lib/content-safety/backfill-store', () => ({ claimBackfillCursor: vi.fn(), saveBackfillCursor: vi.fn() }));
vi.mock('@pagespace/lib/content-safety/alerts', () => ({ sendContentSafetyAlert: vi.fn(async () => undefined) }));

import { createBackfillDeps } from '../backfill-service';
import { createPublishGateDeps } from '../publish-gate-service';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_HASH = createHash('sha256').update(PNG).digest('hex');
const HASH = 'b'.repeat(64);
const asset: BackfillTarget = { kind: 'asset', key: `assets/${HASH}`, contentHash: HASH, derived: false };
const thumbnail: BackfillTarget = { kind: 'asset', key: `assets/cache/${HASH}/thumbnail.webp`, contentHash: HASH, derived: true };
const avatar: BackfillTarget = { kind: 'avatar', key: 'avatars/user-1/avatar.png', userId: 'user-1', extension: 'png' };
const listed = { key: 'k', size: PNG.length };

const flag: ScanResult = { kind: 'classifier_flag', provider: 'hive', category: 'csam', score: 0.97 };
const match: ScanResult = { kind: 'hash_match', provider: 'hive', lists: ['ncmec'], matchTypes: ['CSAM'] };

function build(mode: 'shadow' | 'enforce', result?: ScanResult) {
  const config = resolveScanConfig({ CONTENT_SCAN_MODE: mode, HIVE_API_KEY: 'k' }, { onPrem: false });
  const scanner = createFakeScanner({ defaultResult: result, provider: 'hive' });
  const actions = {
    takePublicOffline: vi.fn(async () => undefined),
    holdAvatarBytes: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => true),
    hideAvatar: vi.fn(async () => true),
    findBlockCaseId: vi.fn(async () => 'case-block'),
    findReviewCaseId: vi.fn(async (): Promise<string | null> => 'case-open'),
    currentVerdict: vi.fn(async (): Promise<StoredVerdict | null> => ({ verdict: 'flagged', outcome: 'classifier_flag', scannedAt: new Date() })),
  };
  const deps = createBackfillDeps(config, { actions, gateDeps: (overrides) => ({ ...createPublishGateDeps(config, overrides), scanner }) });
  return { deps, actions, scanner };
}

beforeEach(() => {
  vi.clearAllMocks();
  send.mockReset();
  executeTakedown.mockReset();
  findScanVerdict.mockResolvedValue(null);
  isHashBlocked.mockResolvedValue(false);
  send.mockResolvedValue({});
  readPublishedObjectBounded.mockResolvedValue({ bytes: PNG, complete: true });
  readS3ObjectBounded.mockResolvedValue({ bytes: PNG, complete: true });
  executeTakedown.mockResolvedValue({ action: 'global', caseId: 'case-td', status: 'actioned' });
});

describe('backfill service: public assets', () => {
  it('scans the bytes being served for a public asset; clean stays up', async () => {
    const { deps, actions, scanner } = build('enforce');
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'clean', scanned: true, removed: false });
    expect(actions.takePublicOffline).not.toHaveBeenCalled();
    expect(readPublishedObjectBounded).toHaveBeenCalledWith(`assets/${HASH}`, expect.any(Number), expect.any(Number));
    expect(scanner.calls).toEqual([HASH]);
  });

  it('gates a derived copy as its private original', async () => {
    const { deps } = build('enforce');
    readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true });
    await deps.process(thumbnail, listed);
    expect(readS3ObjectBounded).toHaveBeenCalledWith(expect.anything(), 'private', `files/${HASH}/original`, expect.any(Number), expect.any(Number));
    expect(readPublishedObjectBounded).not.toHaveBeenCalled();
  });

  it('a hash match runs the global takedown (which removes the public copy), in shadow too', async () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      executeTakedown.mockClear();
      const { deps } = build(mode, match);
      await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'hash_match', scanned: true, removed: true });
      expect(executeTakedown).toHaveBeenCalledWith(expect.objectContaining({ action: 'global', contentHash: HASH, category: 'csam' }), null);
    }
  });

  it('a takedown that stopped part-way takes the public copy down with a private hold under its case, never a bare delete', async () => {
    executeTakedown.mockResolvedValueOnce({ action: 'global', caseId: 'case-td', status: 'open', failedStep: 'unpublish_public' });
    const partial = build('enforce', match);
    await expect(partial.deps.process(asset, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: true });
    expect(partial.actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'case-td');
  });

  it('a takedown that threw (no case) deletes nothing and stops the walk before the item, to retry it', async () => {
    executeTakedown.mockRejectedValueOnce(new Error('db down'));
    const thrown = build('enforce', match);
    await expect(thrown.deps.process(asset, listed)).rejects.toThrow('did not open its case');
    expect(thrown.actions.takePublicOffline).not.toHaveBeenCalled();
  });

  it('a completed takedown does not delete again', async () => {
    const { deps, actions } = build('enforce', match);
    await deps.process(asset, listed);
    expect(actions.takePublicOffline).not.toHaveBeenCalled();
  });

  it('enforce: a classifier flag opens the case and takes the public copy down, with no block', async () => {
    const { deps, actions } = build('enforce', flag);
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'flagged', scanned: true, removed: true });
    // Kept privately under the review case before the public copy goes: it may be the only copy left.
    expect(actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'case-rv');
    expect(executeTakedown).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished', resourceId: HASH, details: expect.objectContaining({ caseId: 'case-rv', mode: 'enforce' }) }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.flagged' }));
  });

  it('enforce: a flag decided from a stored verdict is held under the case open for the hash, else the uncased namespace', async () => {
    findScanVerdict.mockResolvedValue({ verdict: 'flagged', outcome: 'classifier_flag', scannedAt: new Date() });
    const open = build('enforce', flag);
    await expect(open.deps.process(asset, listed)).resolves.toMatchObject({ finding: 'flagged', removed: true });
    expect(open.actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'case-open');
    // The audit names the case the copy is held under, so staff can find it.
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished', details: expect.objectContaining({ caseId: 'case-open' }) }));

    const none = build('enforce', flag);
    none.actions.findReviewCaseId.mockResolvedValueOnce(null);
    await none.deps.process(asset, listed);
    expect(none.actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'backfill-uncased');
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ details: expect.objectContaining({ caseId: null }) }));
  });

  it('enforce: with no case open, a flag that was cleared meanwhile takes nothing offline', async () => {
    findScanVerdict.mockResolvedValue({ verdict: 'flagged', outcome: 'classifier_flag', scannedAt: new Date() });
    const { deps, actions } = build('enforce', flag);
    actions.findReviewCaseId.mockResolvedValueOnce(null);
    // Staff dismissed the case after the gate read the cached flag: the hash is clean now.
    actions.currentVerdict.mockResolvedValueOnce({ verdict: 'clean', outcome: 'clean', scannedAt: new Date() });
    await expect(deps.process(asset, listed)).resolves.toMatchObject({ finding: 'flagged', removed: false });
    expect(actions.takePublicOffline).not.toHaveBeenCalled();
  });

  it('enforce: with no case open, a hash match recorded meanwhile still takes the copy offline under the uncased hold', async () => {
    findScanVerdict.mockResolvedValue({ verdict: 'flagged', outcome: 'classifier_flag', scannedAt: new Date() });
    const { deps, actions } = build('enforce', flag);
    actions.findReviewCaseId.mockResolvedValueOnce(null);
    actions.currentVerdict.mockResolvedValueOnce({ verdict: 'flagged', outcome: 'hash_match', scannedAt: new Date() });
    await expect(deps.process(asset, listed)).resolves.toMatchObject({ removed: true });
    expect(actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'backfill-uncased');
  });

  it('a hash-match takedown another run is still carrying out takes the public copy down here too, with its hold', async () => {
    executeTakedown.mockResolvedValue({ action: 'global', caseId: 'case-td', inProgress: true });
    const { deps, actions } = build('enforce', match);
    await expect(deps.process(asset, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: true });
    expect(actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'case-td');
  });

  it('enforce: a hold that fails leaves the public copy up and stops the walk before the item', async () => {
    const { deps, actions } = build('enforce', flag);
    actions.takePublicOffline.mockRejectedValueOnce(new Error('hold not verified'));
    await expect(deps.process(asset, listed)).rejects.toThrow('hold not verified');
  });

  it('shadow: a classifier flag opens the case and the copy stays up', async () => {
    const { deps, actions } = build('shadow', flag);
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'flagged', scanned: true, removed: false });
    expect(actions.takePublicOffline).not.toHaveBeenCalled();
  });

  it('a blocklisted hash still being served is taken down in every mode, with no scan', async () => {
    isHashBlocked.mockResolvedValue(true);
    const { deps, actions, scanner } = build('shadow');
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'blocked', scanned: false, removed: true });
    expect(actions.takePublicOffline).toHaveBeenCalledWith(HASH, 'case-block');
    expect(scanner.calls).toEqual([]);
  });

  it('a scan error stays up (a vendor outage takes no site down)', async () => {
    const { deps, actions } = build('enforce', { kind: 'error', provider: 'hive', reason: 'timeout' });
    await expect(deps.process(asset, listed)).resolves.toMatchObject({ finding: 'error', removed: false });
    expect(actions.takePublicOffline).not.toHaveBeenCalled();
  });

  it('a blocklist failure throws, so the walk stops before the object', async () => {
    isHashBlocked.mockRejectedValue(new Error('db down'));
    await expect(build('enforce').deps.process(asset, listed)).rejects.toThrow('db down');
  });
});

describe('backfill service: avatars', () => {
  it('reads the avatar, keys it by the hash of its bytes, clean stays up', async () => {
    const { deps, scanner } = build('enforce');
    await expect(deps.process(avatar, listed)).resolves.toEqual({ finding: 'clean', scanned: true, removed: false });
    expect(readS3ObjectBounded).toHaveBeenCalledWith(expect.anything(), 'private', 'avatars/user-1/avatar.png', expect.any(Number), expect.any(Number));
    expect(scanner.calls).toEqual([PNG_HASH]);
  });

  it('a hash-matched avatar that cannot be staged is blocked and hidden, never deleted', async () => {
    send.mockRejectedValueOnce(new Error('s3 down'));
    const { deps, actions } = build('enforce', match);
    // Hidden is not removed (its URL still answers): the walk stops before it and retries next tick.
    await expect(deps.process(avatar, listed)).rejects.toThrow('hidden but not yet deleted');
    expect(executeTakedown).toHaveBeenCalledWith(expect.objectContaining({ action: 'global', contentHash: PNG_HASH }), null);
    expect(actions.hideAvatar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', key: 'avatars/user-1/avatar.png', contentHash: PNG_HASH }));
    expect(actions.removeAvatar).not.toHaveBeenCalled();
    expect(actions.removeAvatar).not.toHaveBeenCalled();
  });

  it('a blocklisted avatar is staged before it is deleted; if it cannot be staged it is only hidden', async () => {
    isHashBlocked.mockResolvedValue(true);
    const staged = build('enforce');
    await expect(staged.deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'blocked', removed: true });
    const put = send.mock.calls.find((call) => call[0].constructor.name === 'PutObjectCommand');
    expect(put?.[0].input).toMatchObject({ Key: `files/${PNG_HASH}/original` });
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(staged.actions.removeAvatar.mock.invocationCallOrder[0]);

    send.mockRejectedValueOnce(new Error('s3 down'));
    const unstaged = build('enforce');
    await expect(unstaged.deps.process(avatar, listed)).rejects.toThrow('hidden but not yet deleted');
    expect(unstaged.actions.hideAvatar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', key: 'avatars/user-1/avatar.png', contentHash: PNG_HASH }));
    expect(unstaged.actions.removeAvatar).not.toHaveBeenCalled();
  });

  it('an avatar larger than any upload is counted as an error, not hashed from its first bytes', async () => {
    readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: false });
    const { deps, scanner } = build('enforce');
    await expect(deps.process(avatar, listed)).resolves.toEqual({ finding: 'error', scanned: false, removed: false });
    expect(scanner.calls).toEqual([]);
  });

  it('an avatar gone since the listing is skipped', async () => {
    readS3ObjectBounded.mockResolvedValueOnce(null);
    await expect(build('enforce').deps.process(avatar, listed)).resolves.toBeNull();
  });

  it('a hash match stages the bytes, runs the global takedown, then removes the scanned avatar only', async () => {
    const { deps, actions } = build('shadow', match);
    await expect(deps.process(avatar, listed)).resolves.toEqual({ finding: 'hash_match', scanned: true, removed: true });
    const put = send.mock.calls.find((call) => call[0].constructor.name === 'PutObjectCommand');
    expect(put?.[0].input).toMatchObject({ Key: `files/${PNG_HASH}/original` });
    expect(executeTakedown).toHaveBeenCalledWith(expect.objectContaining({ action: 'global', contentHash: PNG_HASH }), null);
    // Not the user-wide avatar takedown (which deletes the whole prefix): the scanned object, by its hash and ETag.
    expect(executeTakedown).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'avatar' }), null);
    expect(actions.removeAvatar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', key: 'avatars/user-1/avatar.png', contentHash: PNG_HASH }));
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(actions.removeAvatar.mock.invocationCallOrder[0]);
    // The uploader is named beside the global case, which is keyed by hash.
    expect(securityLog.error).toHaveBeenCalledWith(expect.stringContaining('uploader'), undefined, expect.objectContaining({ caseId: 'case-td', userId: 'user-1' }));
  });

  it('a hash-matched avatar replaced at the removal itself is not counted as removed, and the walk goes on', async () => {
    const { deps, actions } = build('enforce', match);
    actions.removeAvatar.mockResolvedValueOnce(false);
    await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: false });
  });

  it('the avatar comes down when the global takedown stopped part-way: its case exists and is resumable', async () => {
    executeTakedown.mockResolvedValue({ action: 'global', caseId: 'case-td', failedStep: 'preserve' });
    const { deps, actions } = build('enforce', match);
    await deps.process(avatar, listed);
    expect(actions.removeAvatar).toHaveBeenCalled();
  });

  it('a global takedown that left no case (no block, no alert) is not followed by a delete: the avatar is hidden and retried', async () => {
    executeTakedown.mockRejectedValue(new Error('db down'));
    const { deps, actions } = build('enforce', match);
    await expect(deps.process(avatar, listed)).rejects.toThrow('hidden but not yet deleted');
    expect(actions.removeAvatar).not.toHaveBeenCalled();
    expect(actions.hideAvatar).toHaveBeenCalled();
  });

  it('the default hold writes the bytes to content-hold/<case>/<hash> and reads them back before the avatar goes', async () => {
    const { actions } = build('enforce', flag);
    // Every action mocked except the hold, which runs for real against the mocked S3 client.
    const others: Partial<typeof actions> = { ...actions };
    delete others.holdAvatarBytes;
    const config = resolveScanConfig({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' }, { onPrem: false });
    const real = createBackfillDeps(config, {
      actions: others,
      gateDeps: (overrides) => ({ ...createPublishGateDeps(config, overrides), scanner: createFakeScanner({ defaultResult: flag, provider: 'hive' }) }),
    });
    await expect(real.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: true });
    const put = send.mock.calls.find((call) => call[0].constructor.name === 'PutObjectCommand');
    expect(put?.[0].input).toMatchObject({ Key: `content-hold/case-rv/${PNG_HASH}` });
    expect(readS3ObjectBounded).toHaveBeenLastCalledWith(expect.anything(), 'private', `content-hold/case-rv/${PNG_HASH}`, expect.any(Number), expect.any(Number));

    // A copy that reads back different is not a hold: nothing is removed.
    readS3ObjectBounded.mockReset();
    readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockResolvedValueOnce({ bytes: PNG, complete: true }).mockResolvedValue({ bytes: new Uint8Array([1]), complete: true });
    actions.removeAvatar.mockClear();
    await expect(real.process(avatar, listed)).rejects.toThrow('could not be verified');
    expect(actions.removeAvatar).not.toHaveBeenCalled();
  });

  it('enforce: a flagged avatar replaced at the removal itself is not counted as removed, and is not audited', async () => {
    const { deps, actions } = build('enforce', flag);
    actions.removeAvatar.mockResolvedValueOnce(false);
    await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: false });
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished' }));
  });

  it('a blocked avatar that cannot be staged, replaced at the hide itself, is not retried as hidden', async () => {
    isHashBlocked.mockResolvedValue(true);
    send.mockRejectedValueOnce(new Error('s3 down'));
    const { deps, actions } = build('enforce');
    actions.hideAvatar.mockResolvedValueOnce(false);
    await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'blocked', removed: false });
  });

  it('enforce: a flagged avatar whose bytes cannot be held stays in place, and the walk retries it', async () => {
    const { deps, actions } = build('enforce', flag);
    actions.holdAvatarBytes.mockRejectedValueOnce(new Error('hold not verified'));
    await expect(deps.process(avatar, listed)).rejects.toThrow('hold not verified');
    expect(actions.removeAvatar).not.toHaveBeenCalled();
  });

  describe('an avatar replaced while it was being scanned', () => {
    const CLEAN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    // The first read is the bytes scanned; every later read sees the user's new, clean upload.
    const replacedAfterScan = () => readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockResolvedValue({ bytes: CLEAN, complete: true });

    it('enforce: a flagged avatar replaced mid-scan is not removed, and the new one stays', async () => {
      replacedAfterScan();
      const { deps, actions } = build('enforce', flag);
      await expect(deps.process(avatar, listed)).resolves.toEqual({ finding: 'flagged', scanned: true, removed: false });
      expect(actions.removeAvatar).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished' }));
    });

    it('an avatar deleted mid-scan is not removed again', async () => {
      readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockResolvedValue(null);
      const { deps, actions } = build('enforce', flag);
      await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: false });
      expect(actions.removeAvatar).not.toHaveBeenCalled();
    });

    it('a blocklisted avatar replaced mid-scan is staged but neither deleted nor hidden', async () => {
      isHashBlocked.mockResolvedValue(true);
      replacedAfterScan();
      const { deps, actions } = build('enforce');
      await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'blocked', removed: false });
      expect(actions.removeAvatar).not.toHaveBeenCalled();
      expect(actions.hideAvatar).not.toHaveBeenCalled();
    });

    it('a hash-matched avatar replaced mid-scan still blocks the hash, but takes no avatar down', async () => {
      replacedAfterScan();
      const { deps, actions } = build('enforce', match);
      await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: false });
      expect(executeTakedown).toHaveBeenCalledWith(expect.objectContaining({ action: 'global', contentHash: PNG_HASH }), null);
      expect(actions.removeAvatar).not.toHaveBeenCalled();
      expect(actions.hideAvatar).not.toHaveBeenCalled();
    });

    it('a hash-matched avatar that cannot be staged and was replaced is not hidden, and the walk goes on', async () => {
      send.mockRejectedValueOnce(new Error('s3 down'));
      replacedAfterScan();
      const { deps, actions } = build('enforce', match);
      await expect(deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: false });
      expect(actions.hideAvatar).not.toHaveBeenCalled();
    });

    it('a hash match whose re-read fails stops the walk before the item, rather than leaving the avatar up', async () => {
      readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockRejectedValue(new Error('s3 down'));
      const { deps, actions } = build('enforce', match);
      await expect(deps.process(avatar, listed)).rejects.toThrow('s3 down');
      expect(actions.removeAvatar).not.toHaveBeenCalled();
    });

    it('an avatar removal that fails after a hash match stops the walk before the item', async () => {
      const { deps, actions } = build('enforce', match);
      actions.removeAvatar.mockRejectedValueOnce(new Error('processor down'));
      await expect(deps.process(avatar, listed)).rejects.toThrow('processor down');
    });

    const puts = () => send.mock.calls.filter((call) => call[0].constructor.name === 'PutObjectCommand').length;

    it('a hash-matched avatar replaced mid-scan is logged with its case, for staff to tie the uploader to it', async () => {
      replacedAfterScan();
      await build('enforce', match).deps.process(avatar, listed);
      expect(securityLog.error).toHaveBeenCalledWith(expect.stringContaining('uploader'), undefined, expect.objectContaining({ caseId: 'case-td', userId: 'user-1' }));
    });

    it('a replaced avatar whose staging failed is staged again from memory: its stored copy is gone', async () => {
      send.mockRejectedValueOnce(new Error('s3 blip'));
      replacedAfterScan();
      await expect(build('enforce', match).deps.process(avatar, listed)).resolves.toMatchObject({ removed: false });
      expect(puts()).toBe(2);
    });

    it('an unstaged avatar whose hide finds it replaced still has its bytes staged again from memory', async () => {
      for (const blocked of [false, true]) {
        send.mockReset();
        send.mockRejectedValueOnce(new Error('s3 blip')).mockResolvedValue({});
        isHashBlocked.mockResolvedValue(blocked);
        const { deps, actions } = build('enforce', blocked ? undefined : match);
        actions.hideAvatar.mockResolvedValueOnce(false);
        await expect(deps.process(avatar, listed)).resolves.toMatchObject({ removed: false });
        expect(puts()).toBe(2);
      }
    });

    it('a replaced avatar that cannot be staged at all is logged as lost evidence, naming the hash', async () => {
      send.mockRejectedValue(new Error('s3 down'));
      isHashBlocked.mockResolvedValue(true);
      replacedAfterScan();
      await expect(build('enforce').deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'blocked', removed: false });
      expect(securityLog.error).toHaveBeenCalledWith(expect.stringContaining('could not be preserved'), undefined, expect.objectContaining({ contentHash: PNG_HASH }));
    });

    it('a replacement read back too large to hash counts as replaced', async () => {
      readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockResolvedValue({ bytes: PNG, complete: false });
      const { deps, actions } = build('enforce', flag);
      await expect(deps.process(avatar, listed)).resolves.toMatchObject({ removed: false });
      expect(actions.removeAvatar).not.toHaveBeenCalled();
    });

    it('a blocklisted avatar whose re-read fails after staging stops the walk and deletes nothing', async () => {
      isHashBlocked.mockResolvedValue(true);
      readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockRejectedValue(new Error('s3 down'));
      const { deps, actions } = build('enforce');
      await expect(deps.process(avatar, listed)).rejects.toThrow('s3 down');
      expect(actions.removeAvatar).not.toHaveBeenCalled();
    });

    it('shadow reads a flagged avatar once: nothing is removed, so nothing is re-read', async () => {
      await build('shadow', flag).deps.process(avatar, listed);
      expect(readS3ObjectBounded).toHaveBeenCalledTimes(1);
    });

    it('a failed re-read takes nothing down and stops the walk before the item, to retry it', async () => {
      readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: true }).mockRejectedValue(new Error('s3 down'));
      const { deps, actions } = build('enforce', flag);
      await expect(deps.process(avatar, listed)).rejects.toThrow('s3 down');
      expect(actions.removeAvatar).not.toHaveBeenCalled();
    });
  });

  it('enforce: a flagged avatar is removed and audited; shadow leaves it', async () => {
    const enforce = build('enforce', flag);
    await expect(enforce.deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: true });
    expect(enforce.actions.removeAvatar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', key: 'avatars/user-1/avatar.png', contentHash: PNG_HASH }));
    // The scanned bytes are kept under the review case before the only copy is deleted.
    expect(enforce.actions.holdAvatarBytes).toHaveBeenCalledWith('case-rv', PNG_HASH, PNG);
    expect(enforce.actions.holdAvatarBytes.mock.invocationCallOrder[0]).toBeLessThan(enforce.actions.removeAvatar.mock.invocationCallOrder[0]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished', resourceType: 'avatar', details: expect.objectContaining({ userId: 'user-1' }) }));

    const shadow = build('shadow', flag);
    await expect(shadow.deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: false });
    expect(shadow.actions.removeAvatar).not.toHaveBeenCalled();
  });
});

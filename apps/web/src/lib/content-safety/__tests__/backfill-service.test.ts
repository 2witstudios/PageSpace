import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackfillTarget } from '@pagespace/lib/content-safety/backfill';
import { resolveScanConfig } from '@pagespace/lib/content-safety/scan-mode';
import { createFakeScanner, type ScanResult } from '@pagespace/lib/content-safety/scanner';

vi.mock('server-only', () => ({}));

const executeTakedown = vi.fn();
vi.mock('../takedown-service', () => ({ executeTakedown: (...args: unknown[]) => executeTakedown(...args), removeUserAvatar: vi.fn() }));

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
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({ isHashBlocked: (...args: unknown[]) => isHashBlocked(...args) }));
vi.mock('@pagespace/lib/content-safety/scan-store', () => ({
  findScanVerdict: vi.fn(async () => null),
  findScanVerdicts: vi.fn(),
  recordScanVerdict: vi.fn(async () => undefined),
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
  const actions = { removePublicAsset: vi.fn(async () => 1), removeAvatar: vi.fn(async () => undefined), takedownAvatar: vi.fn(async () => undefined) };
  const deps = createBackfillDeps(config, { actions, gateDeps: (overrides) => ({ ...createPublishGateDeps(config, overrides), scanner }) });
  return { deps, actions, scanner };
}

beforeEach(() => {
  vi.clearAllMocks();
  send.mockReset();
  executeTakedown.mockReset();
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
    expect(readPublishedObjectBounded).toHaveBeenCalledWith(`assets/${HASH}`, expect.any(Number), expect.any(Number));
    expect(scanner.calls).toEqual([HASH]);
    expect(actions.removePublicAsset).not.toHaveBeenCalled();
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

  it('a hash-match takedown that stopped part-way, or threw, still takes the public copy down', async () => {
    executeTakedown.mockResolvedValueOnce({ action: 'global', caseId: 'case-td', status: 'open', failedStep: 'unpublish_public' });
    const partial = build('enforce', match);
    await expect(partial.deps.process(asset, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: true });
    expect(partial.actions.removePublicAsset).toHaveBeenCalledWith(HASH);

    executeTakedown.mockRejectedValueOnce(new Error('db down'));
    const thrown = build('enforce', match);
    await expect(thrown.deps.process(asset, listed)).resolves.toMatchObject({ finding: 'hash_match', removed: true });
    expect(thrown.actions.removePublicAsset).toHaveBeenCalledWith(HASH);
  });

  it('a completed takedown does not delete again', async () => {
    const { deps, actions } = build('enforce', match);
    await deps.process(asset, listed);
    expect(actions.removePublicAsset).not.toHaveBeenCalled();
  });

  it('enforce: a classifier flag opens the case and takes the public copy down, with no block', async () => {
    const { deps, actions } = build('enforce', flag);
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'flagged', scanned: true, removed: true });
    expect(actions.removePublicAsset).toHaveBeenCalledWith(HASH);
    expect(executeTakedown).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished', resourceId: HASH, details: expect.objectContaining({ caseId: 'case-rv', mode: 'enforce' }) }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.flagged' }));
  });

  it('shadow: a classifier flag opens the case and the copy stays up', async () => {
    const { deps, actions } = build('shadow', flag);
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'flagged', scanned: true, removed: false });
    expect(actions.removePublicAsset).not.toHaveBeenCalled();
  });

  it('a blocklisted hash still being served is taken down in every mode, with no scan', async () => {
    isHashBlocked.mockResolvedValue(true);
    const { deps, actions, scanner } = build('shadow');
    await expect(deps.process(asset, listed)).resolves.toEqual({ finding: 'blocked', scanned: false, removed: true });
    expect(actions.removePublicAsset).toHaveBeenCalledWith(HASH);
    expect(scanner.calls).toEqual([]);
  });

  it('a scan error stays up (a vendor outage takes no site down)', async () => {
    const { deps, actions } = build('enforce', { kind: 'error', provider: 'hive', reason: 'timeout' });
    await expect(deps.process(asset, listed)).resolves.toMatchObject({ finding: 'error', removed: false });
    expect(actions.removePublicAsset).not.toHaveBeenCalled();
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

  it('a hash-matched avatar that cannot be staged for preservation is not deleted; the walk retries it', async () => {
    send.mockRejectedValueOnce(new Error('s3 down'));
    const { deps, actions } = build('enforce', match);
    await expect(deps.process(avatar, listed)).rejects.toThrow('not staged');
    expect(executeTakedown).not.toHaveBeenCalled();
    expect(actions.takedownAvatar).not.toHaveBeenCalled();
  });

  it('an avatar larger than any upload is skipped, not hashed from its first bytes', async () => {
    readS3ObjectBounded.mockResolvedValueOnce({ bytes: PNG, complete: false });
    await expect(build('enforce').deps.process(avatar, listed)).resolves.toBeNull();
  });

  it('an avatar gone since the listing is skipped', async () => {
    readS3ObjectBounded.mockResolvedValueOnce(null);
    await expect(build('enforce').deps.process(avatar, listed)).resolves.toBeNull();
  });

  it('a hash match stages the bytes, runs the global takedown, then the avatar takedown', async () => {
    const { deps, actions } = build('shadow', match);
    await expect(deps.process(avatar, listed)).resolves.toEqual({ finding: 'hash_match', scanned: true, removed: true });
    const put = send.mock.calls.find((call) => call[0].constructor.name === 'PutObjectCommand');
    expect(put?.[0].input).toMatchObject({ Key: `files/${PNG_HASH}/original` });
    expect(executeTakedown).toHaveBeenCalledWith(expect.objectContaining({ action: 'global', contentHash: PNG_HASH }), null);
    expect(actions.takedownAvatar).toHaveBeenCalledWith('user-1', expect.stringContaining('Hash match'));
  });

  it('the avatar comes down even when the global takedown fails', async () => {
    executeTakedown.mockRejectedValue(new Error('evidence bucket down'));
    const { deps, actions } = build('enforce', match);
    await deps.process(avatar, listed);
    expect(actions.takedownAvatar).toHaveBeenCalled();
  });

  it('enforce: a flagged avatar is removed and audited; shadow leaves it', async () => {
    const enforce = build('enforce', flag);
    await expect(enforce.deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: true });
    expect(enforce.actions.removeAvatar).toHaveBeenCalledWith('user-1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.backfill.unpublished', resourceType: 'avatar', details: expect.objectContaining({ userId: 'user-1' }) }));

    const shadow = build('shadow', flag);
    await expect(shadow.deps.process(avatar, listed)).resolves.toMatchObject({ finding: 'flagged', removed: false });
    expect(shadow.actions.removeAvatar).not.toHaveBeenCalled();
  });
});

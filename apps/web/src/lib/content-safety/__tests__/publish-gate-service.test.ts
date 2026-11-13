import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveScanConfig } from '@pagespace/lib/content-safety/scan-mode';

vi.mock('server-only', () => ({}));

const executeTakedown = vi.fn();
vi.mock('../takedown-service', () => ({ executeTakedown: (...args: unknown[]) => executeTakedown(...args) }));

const send = vi.fn();
vi.mock('@/lib/presigned-url', () => ({
  getS3Bucket: () => 'private',
  getS3Client: () => ({ send: (...args: unknown[]) => send(...args) }),
}));

const securityLog = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { security: securityLog, api: securityLog } }));

const audit = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: (...args: unknown[]) => audit(...args) }));

const isHashBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({ isHashBlocked: (...args: unknown[]) => isHashBlocked(...args) }));

import { createPublishGateDeps, gateAssetForPublish, readPrivateSource } from '../publish-gate-service';

const HASH = 'a'.repeat(64);
const config = (env: Record<string, string>) => resolveScanConfig(env, { onPrem: false });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readPrivateSource', () => {
  it('returns null for a missing original', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
    await expect(readPrivateSource(`files/${HASH}/original`, 100)).resolves.toBeNull();
  });

  it('reads a file that fits whole', async () => {
    send
      .mockResolvedValueOnce({ ContentLength: 3 })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    await expect(readPrivateSource('k', 100)).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), complete: true });
    expect(send.mock.calls[1][0].input).toEqual({ Bucket: 'private', Key: 'k' });
  });

  it('reads only the first bytes of a file over the bound, never all of it', async () => {
    send
      .mockResolvedValueOnce({ ContentLength: 10_000_000 })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array(4096) } });
    const read = await readPrivateSource('k', 1000);
    expect(read?.complete).toBe(false);
    expect(send.mock.calls[1][0].input).toMatchObject({ Range: 'bytes=0-4095' });
  });
});

describe('createPublishGateDeps', () => {
  it('builds no scanner without a key, and a Hive scanner with one', () => {
    expect(createPublishGateDeps(config({ CONTENT_SCAN_MODE: 'enforce' })).scanner).toBeNull();
    vi.stubEnv('HIVE_API_KEY', 'k');
    expect(createPublishGateDeps(config({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' })).scanner?.provider).toBe('hive');
    vi.unstubAllEnvs();
  });

  it('a hash match runs the global takedown as the system, category csam', async () => {
    executeTakedown.mockResolvedValue({ action: 'global', caseId: 'case-1', status: 'actioned' });
    const deps = createPublishGateDeps(config({ CONTENT_SCAN_MODE: 'shadow' }));
    await expect(deps.takedownHashMatch({ contentHash: HASH, lists: ['ncmec'] })).resolves.toEqual({ caseId: 'case-1' });
    expect(executeTakedown).toHaveBeenCalledWith(
      { action: 'global', contentHash: HASH, category: 'csam', reason: 'Hash match from the publish scan (lists: ncmec)' },
      null,
    );
  });

  it('logs a takedown that stopped part-way', async () => {
    executeTakedown.mockResolvedValue({ action: 'global', caseId: 'case-1', status: 'open', failedStep: 'preserve' });
    await createPublishGateDeps(config({ CONTENT_SCAN_MODE: 'shadow' })).takedownHashMatch({ contentHash: HASH, lists: [] });
    expect(securityLog.error).toHaveBeenCalledWith(expect.stringContaining('stopped part-way'), undefined, expect.objectContaining({ failedStep: 'preserve' }));
  });

  it('audits by hash with a risk score, never more than the details given', () => {
    createPublishGateDeps(config({})).audit({ eventType: 'content.scan.hash_match', contentHash: HASH, userId: 'u', details: { fileId: 'f' } });
    expect(audit).toHaveBeenCalledWith({ eventType: 'content.scan.hash_match', userId: 'u', resourceType: 'file', resourceId: HASH, details: { fileId: 'f' }, riskScore: 1 });
  });

  it('logs enforce-without-a-key once, however many assets are gated', async () => {
    isHashBlocked.mockResolvedValue(false);
    const deps = createPublishGateDeps(config({ CONTENT_SCAN_MODE: 'enforce' }));
    const input = { contentHash: HASH, originalKey: `files/${HASH}/original`, declaredContentType: 'image/png', fileId: 'f', userId: 'u', entryPoint: 'canvas_asset' as const };
    await expect(gateAssetForPublish(input, deps)).resolves.toEqual({ promote: false, reason: 'held' });
    await gateAssetForPublish(input, deps);
    const calls = securityLog.error.mock.calls.filter(([message]) => String(message).includes('HIVE_API_KEY is not set'));
    expect(calls).toHaveLength(1);
  });
});

describe('gateAssetForPublish', () => {
  it('holds the asset when the gate itself fails (e.g. the blocklist is unreachable)', async () => {
    isHashBlocked.mockRejectedValue(new Error('db down'));
    const deps = createPublishGateDeps(config({ CONTENT_SCAN_MODE: 'off' }));
    await expect(
      gateAssetForPublish({ contentHash: HASH, originalKey: 'k', declaredContentType: null, fileId: 'f', userId: null, entryPoint: 'canvas_asset' }, deps),
    ).resolves.toEqual({ promote: false, reason: 'held' });
  });
});

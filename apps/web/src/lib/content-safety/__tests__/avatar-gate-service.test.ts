import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveScanConfig } from '@pagespace/lib/content-safety/scan-mode';
import { createFakeScanner, type ScanResult } from '@pagespace/lib/content-safety/scanner';

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
const recordScanVerdict = vi.fn();
vi.mock('@pagespace/lib/content-safety/scan-store', () => ({
  findScanVerdict: vi.fn(async () => null),
  recordScanVerdict: (...args: unknown[]) => recordScanVerdict(...args),
  openScanReviewCase: vi.fn(async () => ({ caseId: 'case-rv', created: true, firstFlag: true })),
}));
vi.mock('@pagespace/lib/content-safety/alerts', () => ({ sendContentSafetyAlert: vi.fn(async () => undefined) }));

import { createAvatarGateDeps, gateAvatarBytes } from '../avatar-gate-service';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HASH = createHash('sha256').update(PNG).digest('hex');
const config = (mode: 'shadow' | 'enforce') => resolveScanConfig({ CONTENT_SCAN_MODE: mode, HIVE_API_KEY: 'k' }, { onPrem: false });

beforeEach(() => {
  vi.clearAllMocks();
  isHashBlocked.mockResolvedValue(false);
  send.mockResolvedValue({});
  recordScanVerdict.mockResolvedValue(undefined);
  executeTakedown.mockResolvedValue({ action: 'global', caseId: 'case-td', status: 'actioned' });
});

function depsWith(mode: 'shadow' | 'enforce', result: ScanResult | undefined) {
  const deps = createAvatarGateDeps(PNG, config(mode));
  return { ...deps, scanner: createFakeScanner({ defaultResult: result, provider: 'hive' }) };
}

describe('avatar gate service', () => {
  it('a hash match stages the bytes at files/<hash>/original, then runs the global takedown, and refuses', async () => {
    const deps = depsWith('shadow', { kind: 'hash_match', provider: 'hive', lists: ['ncmec'], matchTypes: ['CSAM'] });
    await expect(gateAvatarBytes(PNG, 'user-1', deps)).resolves.toMatchObject({ accept: false, finding: 'hash_match' });

    const put = send.mock.calls.find((call) => call[0].constructor.name === 'PutObjectCommand');
    expect(put?.[0].input).toMatchObject({ Bucket: 'private', Key: `files/${HASH}/original` });
    expect(executeTakedown).toHaveBeenCalledWith(
      { action: 'global', contentHash: HASH, category: 'csam', reason: 'Hash match from an avatar upload scan (lists: ncmec)' },
      null,
    );
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(executeTakedown.mock.invocationCallOrder[0]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.avatar.rejected', resourceId: HASH, userId: 'user-1', riskScore: 1 }));
  });

  it('the takedown still runs when staging the bytes fails', async () => {
    send.mockRejectedValueOnce(new Error('s3 down'));
    const deps = depsWith('enforce', { kind: 'hash_match', provider: 'hive', lists: [], matchTypes: [] });
    await gateAvatarBytes(PNG, 'user-1', deps);
    expect(executeTakedown).toHaveBeenCalled();
    expect(securityLog.error).toHaveBeenCalledWith(expect.stringContaining('stage'), undefined, expect.anything());
  });

  it('shadow accepts a flag, recording the verdict by the hash of the bytes', async () => {
    const deps = depsWith('shadow', { kind: 'classifier_flag', provider: 'hive', category: 'csam', score: 0.95 });
    await expect(gateAvatarBytes(PNG, 'user-1', deps)).resolves.toMatchObject({ accept: true });
    expect(recordScanVerdict).toHaveBeenCalledWith(expect.objectContaining({ contentHash: HASH, verdict: 'flagged', mode: 'shadow' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.flagged', resourceId: HASH }));
  });

  it('a gate that throws (blocklist unreachable) refuses', async () => {
    isHashBlocked.mockRejectedValue(new Error('db down'));
    await expect(gateAvatarBytes(PNG, 'user-1', depsWith('shadow', undefined))).resolves.toEqual({ accept: false, reason: 'error' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AVATAR_IMAGE_TYPES, gateAvatarUpload, identifyAvatarImage, sha256Hex, type AvatarGateDeps } from '../avatar-gate';
import { resolveScanConfig } from '../scan-mode';
import { createFakeScanner, type ScanResult } from '../scanner';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
const WEBP = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ');
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const PDF = new TextEncoder().encode('%PDF-1.7 ...');
const MP4 = Uint8Array.from('\0\0\0\x18ftypisom\0\0\0\0isommp41', (c) => c.charCodeAt(0));
const BMP = new Uint8Array([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0]);

function setup(options: { mode?: 'off' | 'shadow' | 'enforce'; result?: ScanResult; blocked?: boolean; key?: boolean } = {}) {
  const config = resolveScanConfig(
    { CONTENT_SCAN_MODE: options.mode ?? 'enforce', HIVE_API_KEY: options.key === false ? '' : 'k' },
    { onPrem: false },
  );
  const scanner = createFakeScanner({ defaultResult: options.result });
  const deps = {
    config,
    scanner: config.scannerConfigured ? scanner : null,
    isBlocked: vi.fn(async () => options.blocked ?? false),
    findVerdict: vi.fn(async () => null),
    recordVerdict: vi.fn(async (): Promise<{ keptFlag: boolean; keptHashMatch?: boolean }> => ({ keptFlag: false })),
    takedownHashMatch: vi.fn(async () => ({ caseId: 'case-td' })),
    openReviewCase: vi.fn(async (): Promise<{ caseId: string; created: boolean; firstFlag: boolean; keptHashMatch?: boolean }> => ({ caseId: 'case-rv', created: true, firstFlag: true })),
    alert: vi.fn(async () => undefined),
    audit: vi.fn(),
    auditRejected: vi.fn(),
    reportMisconfiguration: vi.fn(),
    logError: vi.fn(),
    now: () => new Date('2026-11-13T00:00:00Z'),
  } satisfies AvatarGateDeps;
  return { deps, scanner };
}

const flag: ScanResult = { kind: 'classifier_flag', provider: 'fake', category: 'csam', score: 0.97 };
const match: ScanResult = { kind: 'hash_match', provider: 'fake', lists: ['ncmec'], matchTypes: ['CSAM'] };
const error: ScanResult = { kind: 'error', provider: 'fake', reason: 'timeout' };

describe('identifyAvatarImage', () => {
  it('accepts the four avatar types by their bytes, with the extension they are stored under', () => {
    expect(identifyAvatarImage(PNG)).toEqual({ contentType: 'image/png', extension: '.png' });
    expect(identifyAvatarImage(JPEG)).toEqual({ contentType: 'image/jpeg', extension: '.jpg' });
    expect(identifyAvatarImage(GIF)).toEqual({ contentType: 'image/gif', extension: '.gif' });
    expect(identifyAvatarImage(WEBP)).toEqual({ contentType: 'image/webp', extension: '.webp' });
    expect(Object.keys(AVATAR_IMAGE_TYPES)).toHaveLength(4);
  });

  it('refuses anything else, whatever it would be declared as', () => {
    for (const bytes of [HTML, PDF, MP4, BMP, new Uint8Array(0), new Uint8Array([1, 2, 3])]) {
      expect(identifyAvatarImage(bytes)).toBeNull();
    }
  });
});

describe('gateAvatarUpload', () => {
  it('a magic-byte mismatch is refused in every mode, before the blocklist or the scanner', async () => {
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      const { deps, scanner } = setup({ mode });
      const result = await gateAvatarUpload({ bytes: HTML, userId: 'user-1' }, deps);
      expect(result).toMatchObject({ accept: false, reason: 'not_an_image' });
      expect(deps.isBlocked).not.toHaveBeenCalled();
      expect(scanner.calls).toEqual([]);
      expect(deps.auditRejected).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', reason: 'not_an_image', mode }));
    }
  });

  it('a clean image is accepted, its verdict recorded by the SHA-256 of the bytes', async () => {
    const { deps, scanner } = setup();
    const result = await gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps);
    expect(result).toEqual({ accept: true, contentType: 'image/png', extension: '.png', contentHash: sha256Hex(PNG), finding: 'clean' });
    expect(scanner.calls).toEqual([sha256Hex(PNG)]);
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ contentHash: sha256Hex(PNG), verdict: 'clean', mode: 'enforce' }));
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'content.scan.clean', details: expect.objectContaining({ entryPoint: 'user_avatar', fileId: null }) }));
    expect(deps.auditRejected).not.toHaveBeenCalled();
  });

  it('a blocked hash is refused in every mode', async () => {
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      const { deps } = setup({ mode, blocked: true });
      await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, reason: 'blocked' });
    }
  });

  it('a hash match runs the global takedown and is refused, in shadow too', async () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      const { deps } = setup({ mode, result: match });
      await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, reason: 'held', finding: 'hash_match' });
      expect(deps.takedownHashMatch).toHaveBeenCalledWith({ contentHash: sha256Hex(PNG), lists: ['ncmec'] });
    }
  });

  it('enforce refuses a classifier flag, opens a review case and alerts', async () => {
    const { deps } = setup({ result: flag });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, reason: 'held', finding: 'flagged' });
    expect(deps.openReviewCase).toHaveBeenCalledWith(expect.objectContaining({ contentHash: sha256Hex(PNG), mode: 'enforce' }));
    expect(deps.alert).toHaveBeenCalledWith({ event: 'scan_flagged', caseId: 'case-rv', category: 'csam' });
    expect(deps.takedownHashMatch).not.toHaveBeenCalled();
  });

  it('enforce refuses a scan error or timeout', async () => {
    const { deps } = setup({ result: error });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, reason: 'held', finding: 'error' });
  });

  it('enforce with no vendor key refuses (fails closed)', async () => {
    const { deps } = setup({ key: false });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, reason: 'held', finding: 'unavailable' });
  });

  it('shadow accepts a flag but records it and opens the case', async () => {
    const { deps } = setup({ mode: 'shadow', result: flag });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: true, finding: 'flagged' });
    // The flagged verdict is recorded with its case, in one transaction (openReviewCase), never on its own.
    expect(deps.recordVerdict).not.toHaveBeenCalled();
    expect(deps.openReviewCase).toHaveBeenCalledWith(expect.objectContaining({ mode: 'shadow', scores: expect.any(Object) }));
    expect(deps.alert).toHaveBeenCalled();
  });

  it('shadow accepts a scan error but records it', async () => {
    const { deps } = setup({ mode: 'shadow', result: error });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: true, finding: 'error' });
    expect(deps.recordVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error', mode: 'shadow' }));
  });

  it('shadow refuses an avatar whose hash was blocked while it was scanned (its clean result lost to the match)', async () => {
    const { deps } = setup({ mode: 'shadow' });
    deps.recordVerdict.mockResolvedValueOnce({ keptFlag: true, keptHashMatch: true });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, finding: 'blocked' });
  });

  it('shadow refuses a flagged avatar whose hash was blocked while it was scanned', async () => {
    const { deps } = setup({ mode: 'shadow', result: flag });
    deps.openReviewCase.mockResolvedValueOnce({ caseId: 'case-rv', created: true, firstFlag: true, keptHashMatch: true });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false, finding: 'blocked' });
  });

  it('off accepts a real image without scanning (the blocklist still applies)', async () => {
    const { deps, scanner } = setup({ mode: 'off' });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: true, finding: 'off' });
    expect(deps.isBlocked).toHaveBeenCalled();
    expect(scanner.calls).toEqual([]);
  });

  it('a blocklist read failure throws, so the caller refuses', async () => {
    const { deps } = setup();
    deps.isBlocked.mockRejectedValueOnce(new Error('db down'));
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).rejects.toThrow('db down');
  });

  it('a failing rejection audit never changes the decision', async () => {
    const { deps } = setup({ result: flag });
    deps.auditRejected.mockImplementation(() => {
      throw new Error('audit down');
    });
    await expect(gateAvatarUpload({ bytes: PNG, userId: 'user-1' }, deps)).resolves.toMatchObject({ accept: false });
  });
});

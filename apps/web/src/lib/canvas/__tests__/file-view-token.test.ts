import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCanvasFileViewToken,
  verifyCanvasFileViewToken,
} from '../file-view-token';

const SECRET = 'test-canvas-file-view-secret-minimum-32-chars';

describe('canvas file view tokens', () => {
  const originalSecret = process.env.CANVAS_FILE_VIEW_SECRET;
  const originalCsrfSecret = process.env.CSRF_SECRET;

  beforeEach(() => {
    process.env.CANVAS_FILE_VIEW_SECRET = SECRET;
    delete process.env.CSRF_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CANVAS_FILE_VIEW_SECRET;
    } else {
      process.env.CANVAS_FILE_VIEW_SECRET = originalSecret;
    }

    if (originalCsrfSecret === undefined) {
      delete process.env.CSRF_SECRET;
    } else {
      process.env.CSRF_SECRET = originalCsrfSecret;
    }
  });

  it('given a token for a drive and file page, should verify before expiry', () => {
    const token = createCanvasFileViewToken({
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 1_000,
      ttlMs: 60_000,
    });

    expect(verifyCanvasFileViewToken({
      token,
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 30_000,
    })).toBe(true);
  });

  it('given a token replayed for a different drive or file page, should reject it', () => {
    const token = createCanvasFileViewToken({
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 1_000,
      ttlMs: 60_000,
    });

    expect(verifyCanvasFileViewToken({
      token,
      driveId: 'drive-2',
      pageId: 'file-1',
      nowMs: 30_000,
    })).toBe(false);
    expect(verifyCanvasFileViewToken({
      token,
      driveId: 'drive-1',
      pageId: 'file-2',
      nowMs: 30_000,
    })).toBe(false);
  });

  it('given an expired or tampered token, should reject it', () => {
    const token = createCanvasFileViewToken({
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 1_000,
      ttlMs: 60_000,
    });

    expect(verifyCanvasFileViewToken({
      token,
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 62_000,
    })).toBe(false);
    expect(verifyCanvasFileViewToken({
      token: `${token}x`,
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 30_000,
    })).toBe(false);
  });

  it('given no dedicated secret, should fall back to CSRF_SECRET', () => {
    delete process.env.CANVAS_FILE_VIEW_SECRET;
    process.env.CSRF_SECRET = SECRET;

    const token = createCanvasFileViewToken({
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 1_000,
      ttlMs: 60_000,
    });

    expect(verifyCanvasFileViewToken({
      token,
      driveId: 'drive-1',
      pageId: 'file-1',
      nowMs: 30_000,
    })).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  streamOriginalToFile: vi.fn().mockResolvedValue(undefined),
  saveCache: vi.fn().mockResolvedValue({}),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('util', () => ({
  promisify: () => mocks.execFile,
}));

vi.mock('fs/promises', () => ({
  default: { readFile: mocks.readFile, unlink: mocks.unlink },
  readFile: mocks.readFile,
  unlink: mocks.unlink,
}));

vi.mock('../../server', () => ({
  contentStore: {
    streamOriginalToFile: mocks.streamOriginalToFile,
    saveCache: mocks.saveCache,
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    processor: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { processVideo, isVideo } from '../video-processor';

const VALID_HASH = 'a'.repeat(64);

const FFPROBE_OUTPUT = JSON.stringify({
  streams: [{ duration: '120.5', width: 1920, height: 1080 }],
});

describe('processVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.streamOriginalToFile.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(Buffer.from('thumb-data'));
    mocks.saveCache.mockResolvedValue({});
    mocks.unlink.mockResolvedValue(undefined);
    // First call: ffmpeg (no output), second call: ffprobe (JSON output)
    mocks.execFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: FFPROBE_OUTPUT, stderr: '' });
  });

  it('streams original from S3, extracts thumbnail, saves to cache', async () => {
    await processVideo({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'video/mp4' });

    expect(mocks.streamOriginalToFile).toHaveBeenCalledWith(VALID_HASH, expect.stringContaining('video-page-1'));
    expect(mocks.saveCache).toHaveBeenCalledWith(
      VALID_HASH,
      'thumbnail.webp',
      expect.any(Buffer),
      'image/webp'
    );
  });

  it('returns duration, width, height from ffprobe', async () => {
    const result = await processVideo({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'video/mp4' });

    expect(result.success).toBe(true);
    expect(result.duration).toBe(120.5);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.thumbnailKey).toBe(`cache/${VALID_HASH}/thumbnail.webp`);
  });

  it('cleans up temp files after successful processing', async () => {
    await processVideo({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'video/mp4' });

    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it('cleans up temp files even when processing fails', async () => {
    mocks.execFile.mockReset();
    mocks.execFile.mockRejectedValueOnce(new Error('ffmpeg failed'));

    await expect(
      processVideo({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'video/mp4' })
    ).rejects.toThrow('ffmpeg failed');

    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it('throws when S3 stream fails', async () => {
    mocks.streamOriginalToFile.mockRejectedValueOnce(new Error('S3 not found'));

    await expect(
      processVideo({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'video/mp4' })
    ).rejects.toThrow('S3 not found');
  });

  it('handles missing ffprobe stream data gracefully', async () => {
    mocks.execFile.mockReset();
    mocks.execFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ streams: [] }), stderr: '' });

    const result = await processVideo({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'video/mp4' });

    expect(result.success).toBe(true);
    expect(result.duration).toBeUndefined();
    expect(result.width).toBeUndefined();
  });
});

describe('isVideo', () => {
  it('returns true for video/mp4', () => expect(isVideo('video/mp4')).toBe(true));
  it('returns true for video/webm', () => expect(isVideo('video/webm')).toBe(true));
  it('returns true for video/quicktime', () => expect(isVideo('video/quicktime')).toBe(true));
  it('returns false for image/jpeg', () => expect(isVideo('image/jpeg')).toBe(false));
  it('returns false for application/pdf', () => expect(isVideo('application/pdf')).toBe(false));
});

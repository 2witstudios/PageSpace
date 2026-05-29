import { describe, it, expect, vi, beforeEach } from 'vitest';

// ffmpeg/ffprobe are mocked because the binaries are not guaranteed in CI — this
// matches the existing video-processor test strategy. The functions under test
// are not mocked; only the subprocess + temp-file boundary is.
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('util', () => ({ promisify: () => mocks.execFile }));
vi.mock('fs/promises', () => ({
  default: { writeFile: mocks.writeFile, readFile: mocks.readFile, unlink: mocks.unlink },
  writeFile: mocks.writeFile,
  readFile: mocks.readFile,
  unlink: mocks.unlink,
}));

import { extractVideoMetadata, extractVideoThumbnail } from '../processing-pipeline';

const VIDEO_BYTES = Buffer.from('fake-mp4-bytes');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
});

describe('extractVideoMetadata', () => {
  it('returns duration, width, and height parsed from ffprobe output', async () => {
    mocks.execFile.mockResolvedValue({
      stdout: JSON.stringify({ streams: [{ duration: '12.5', width: 1920, height: 1080 }] }),
    });
    const meta = await extractVideoMetadata(VIDEO_BYTES);
    expect(meta).toEqual({ duration: 12.5, width: 1920, height: 1080 });
  });

  it('returns an object with undefined fields when ffprobe finds no video stream', async () => {
    mocks.execFile.mockResolvedValue({ stdout: JSON.stringify({ streams: [] }) });
    const meta = await extractVideoMetadata(VIDEO_BYTES);
    expect(meta.duration).toBeUndefined();
    expect(meta.width).toBeUndefined();
  });

  it('cleans up the temp input file even when ffprobe fails', async () => {
    mocks.execFile.mockRejectedValue(new Error('ffprobe boom'));
    await expect(extractVideoMetadata(VIDEO_BYTES)).rejects.toThrow();
    expect(mocks.unlink).toHaveBeenCalled();
  });
});

describe('extractVideoThumbnail', () => {
  it('returns the thumbnail bytes produced by ffmpeg', async () => {
    const thumb = Buffer.from('webp-thumb-bytes');
    mocks.execFile.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.readFile.mockResolvedValue(thumb);
    const result = await extractVideoThumbnail(VIDEO_BYTES);
    expect(result).toEqual(thumb);
  });

  it('cleans up temp files even when ffmpeg fails', async () => {
    mocks.execFile.mockRejectedValue(new Error('ffmpeg boom'));
    await expect(extractVideoThumbnail(VIDEO_BYTES)).rejects.toThrow();
    expect(mocks.unlink).toHaveBeenCalled();
  });
});

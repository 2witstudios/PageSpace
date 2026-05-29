import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOriginal: vi.fn(),
  deleteOriginal: vi.fn().mockResolvedValue(true),
  saveCache: vi.fn().mockResolvedValue({}),
  setPageProcessing: vi.fn().mockResolvedValue(undefined),
  setPageCompleted: vi.fn().mockResolvedValue(undefined),
  setPageVisual: vi.fn().mockResolvedValue(undefined),
  setPageVideoProcessed: vi.fn().mockResolvedValue(undefined),
  setPageFailed: vi.fn().mockResolvedValue(undefined),
  verifyContentHash: vi.fn(),
  detectContentType: vi.fn(),
  isAllowedContentType: vi.fn(),
  extractTextContent: vi.fn(),
  generateImageVariants: vi.fn(),
  extractVideoMetadata: vi.fn(),
  extractVideoThumbnail: vi.fn(),
}));

vi.mock('../../server', () => ({
  contentStore: {
    getOriginal: mocks.getOriginal,
    deleteOriginal: mocks.deleteOriginal,
    saveCache: mocks.saveCache,
  },
}));

vi.mock('../../db', () => ({
  setPageProcessing: mocks.setPageProcessing,
  setPageCompleted: mocks.setPageCompleted,
  setPageVisual: mocks.setPageVisual,
  setPageVideoProcessed: mocks.setPageVideoProcessed,
  setPageFailed: mocks.setPageFailed,
}));

vi.mock('../../services/processing-pipeline', () => ({
  verifyContentHash: mocks.verifyContentHash,
  detectContentType: mocks.detectContentType,
  isAllowedContentType: mocks.isAllowedContentType,
  extractTextContent: mocks.extractTextContent,
  generateImageVariants: mocks.generateImageVariants,
  extractVideoMetadata: mocks.extractVideoMetadata,
  extractVideoThumbnail: mocks.extractVideoThumbnail,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { processor: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { fetchObjectFromS3, runPullPipeline } from '../s3-pull-adapter';

const HASH = 'c'.repeat(64);
const BYTES = Buffer.from('stored-bytes');
const NO_WAIT = { delayMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteOriginal.mockResolvedValue(true);
  mocks.verifyContentHash.mockReturnValue(true);
  mocks.isAllowedContentType.mockReturnValue(true);
  mocks.detectContentType.mockResolvedValue({ label: 'pdf', mimeType: 'application/pdf', score: 0.9, source: 'magika' });
  mocks.extractTextContent.mockResolvedValue('extracted text');
  mocks.generateImageVariants.mockResolvedValue({ thumbnail: Buffer.from('t'), preview: Buffer.from('p') });
  mocks.extractVideoMetadata.mockResolvedValue({ duration: 10, width: 640, height: 480 });
  mocks.extractVideoThumbnail.mockResolvedValue(Buffer.from('thumb'));
});

describe('fetchObjectFromS3', () => {
  it('returns the object bytes when present on the first try', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    const result = await fetchObjectFromS3(HASH, NO_WAIT);
    expect(result).toEqual(BYTES);
    expect(mocks.getOriginal).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times when the object is not yet committed', async () => {
    mocks.getOriginal
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(BYTES);
    const result = await fetchObjectFromS3(HASH, NO_WAIT);
    expect(result).toEqual(BYTES);
    expect(mocks.getOriginal).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    mocks.getOriginal.mockResolvedValue(null);
    await expect(fetchObjectFromS3(HASH, NO_WAIT)).rejects.toThrow();
    expect(mocks.getOriginal).toHaveBeenCalledTimes(3);
  });
});

describe('runPullPipeline — zero-trust gates', () => {
  it('deletes the object and fails the job when the stored bytes do not match the hash', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.verifyContentHash.mockReturnValue(false);

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.deleteOriginal).toHaveBeenCalledWith(HASH);
    expect(mocks.setPageFailed).toHaveBeenCalled();
    expect(mocks.setPageCompleted).not.toHaveBeenCalled();
  });

  it('deletes the object and fails the job when the detected type is disallowed', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'elf', mimeType: 'application/octet-stream', score: 0.9, source: 'magika' });
    mocks.isAllowedContentType.mockReturnValue(false);

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.deleteOriginal).toHaveBeenCalledWith(HASH);
    expect(mocks.setPageFailed).toHaveBeenCalled();
  });

  it('does not delete or persist when verification passes and type is allowed', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);
    expect(mocks.deleteOriginal).not.toHaveBeenCalled();
  });
});

describe('runPullPipeline — dispatch by detected type', () => {
  it('extracts text and marks the page completed for a PDF', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'pdf', mimeType: 'application/pdf', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.extractTextContent).toHaveBeenCalledWith(BYTES, 'application/pdf');
    expect(mocks.setPageCompleted).toHaveBeenCalledWith('page-1', 'extracted text', expect.anything(), expect.any(String));
  });

  it('generates image variants and marks the page visual for an image', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'png', mimeType: 'image/png', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.generateImageVariants).toHaveBeenCalledWith(BYTES);
    expect(mocks.saveCache).toHaveBeenCalled();
    expect(mocks.setPageVisual).toHaveBeenCalledWith('page-1');
  });

  it('extracts metadata + thumbnail and records video processing for a video', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'mp4', mimeType: 'video/mp4', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.extractVideoMetadata).toHaveBeenCalledWith(BYTES);
    expect(mocks.extractVideoThumbnail).toHaveBeenCalledWith(BYTES);
    expect(mocks.setPageVideoProcessed).toHaveBeenCalled();
  });

  it('falls back to visual for an allowed but unsupported type', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'bin', mimeType: 'application/octet-stream', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.setPageVisual).toHaveBeenCalledWith('page-1');
    expect(mocks.setPageCompleted).not.toHaveBeenCalled();
  });

  it('marks the page failed when the object can never be fetched', async () => {
    mocks.getOriginal.mockResolvedValue(null);
    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);
    expect(mocks.setPageFailed).toHaveBeenCalled();
  });
});

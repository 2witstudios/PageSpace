import { describe, it, expect, vi } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  sha256Hex,
  buildImageFilePageValues,
  createImageFilePage,
  imageFileName,
  GENERATED_IMAGES_FOLDER,
  ImageStorageQuotaError,
  type FilePageWrite,
} from '../create-file-page';

const buf = Buffer.from('hello-image');
const HASH = sha256Hex(buf);

describe('sha256Hex (pure)', () => {
  it('is a lowercase 64-hex digest', () => {
    assert({ given: 'a buffer', should: 'be 64 hex chars', actual: /^[0-9a-f]{64}$/.test(HASH), expected: true });
  });
});

describe('buildImageFilePageValues (pure)', () => {
  const now = new Date('2026-07-11T00:00:00.000Z');
  const v = buildImageFilePageValues({
    pageId: 'page1', contentHash: HASH, driveId: 'drive1', parentId: 'folder1',
    title: 'red panda', mimeType: 'image/jpeg', fileSize: buf.length, userId: 'user1',
    position: 3, prompt: 'a red panda', now,
  });

  it('produces a FILE page whose filePath is the content hash', () => {
    assert({
      given: 'image page params',
      should: 'set type FILE, filePath=hash, contentHash=hash',
      actual: { type: v.type, filePath: v.filePath, contentHash: v.contentHash, parentId: v.parentId, position: v.position },
      expected: { type: 'FILE', filePath: HASH, contentHash: HASH, parentId: 'folder1', position: 3 },
    });
  });

  it('marks the page as visual (terminal), never pending — no processor job is enqueued', () => {
    // 'pending' would leave read_page reporting "still being processed" forever.
    assert({
      given: 'a generated image (bytes are the final artifact)',
      should: 'stamp the terminal visual status the processor would assign',
      actual: { processingStatus: v.processingStatus, extractionMethod: v.extractionMethod },
      expected: { processingStatus: 'visual', extractionMethod: 'visual' },
    });
  });

  it('gives the stored file a real extension for downloads', () => {
    assert({
      given: 'an image/jpeg generation titled "red panda"',
      should: 'store originalFileName with a .jpg extension',
      actual: v.originalFileName,
      expected: 'red panda.jpg',
    });
    assert({
      given: 'a png media type',
      should: 'map to .png',
      actual: imageFileName('cat', 'image/png'),
      expected: 'cat.png',
    });
    assert({
      given: 'an unknown media type',
      should: 'leave the title unchanged rather than invent an extension',
      actual: imageFileName('cat', 'image/unknown'),
      expected: 'cat',
    });
  });

  it('stamps provenance into fileMetadata', () => {
    assert({
      given: 'a prompt',
      should: 'record it under fileMetadata with source=image-generation',
      actual: (v.fileMetadata as Record<string, unknown>).prompt,
      expected: 'a red panda',
    });
    expect((v.fileMetadata as Record<string, unknown>).source).toBe('image-generation');
  });
});

describe('createImageFilePage (shell, all seams injected)', () => {
  const okQuota = vi.fn(async (_u: string, _b: number) => ({ allowed: true }));

  it('checks quota, defaults to the Home gallery, persists, and charges storage on first store', async () => {
    const putObject = vi.fn(async (_key: string, _body: Buffer, _ct: string) => undefined);
    const resolveGalleryParent = vi.fn(async () => ({ driveId: 'home1', parentId: 'gallery1' }));
    const getNextPosition = vi.fn(async () => 5);
    let written: FilePageWrite | undefined;
    const persist = vi.fn(async (w: FilePageWrite) => { written = w; return { fileWasInserted: true }; });
    const chargeStorage = vi.fn(async () => {});

    const out = await createImageFilePage(
      { userId: 'user1', buffer: buf, mimeType: 'image/jpeg', title: 'red panda', prompt: 'p' },
      { putObject, resolveGalleryParent, getNextPosition, persist, checkQuota: okQuota, chargeStorage },
    );

    assert({
      given: 'no target (default gallery)',
      should: 'resolve the Home gallery and return its driveId/parent',
      actual: { driveId: out.driveId, parentId: out.parentId, galleryCalled: resolveGalleryParent.mock.calls.length },
      expected: { driveId: 'home1', parentId: 'gallery1', galleryCalled: 1 },
    });
    assert({
      given: 'the bytes',
      should: 'put them to the content-addressed S3 key',
      actual: putObject.mock.calls[0][0],
      expected: `files/${HASH}/original`,
    });
    assert({
      given: 'the persisted write',
      should: 'link file→page with source image-generation',
      actual: { fileId: written?.fileRow.id, linkSource: written?.junction.linkSource, pageParent: written?.pageValues.parentId },
      expected: { fileId: HASH, linkSource: 'image-generation', pageParent: 'gallery1' },
    });
    assert({
      given: 'a newly stored blob',
      should: 'charge storage for its byte count',
      actual: chargeStorage.mock.calls[0]?.slice(0, 2),
      expected: ['user1', buf.length],
    });
  });

  it('does NOT charge storage on a dedup store (fileWasInserted false)', async () => {
    const chargeStorage = vi.fn(async () => {});
    await createImageFilePage(
      { userId: 'u', buffer: buf, mimeType: 'image/png', title: 't' },
      {
        putObject: async () => undefined,
        resolveGalleryParent: async () => ({ driveId: 'd', parentId: 'p' }),
        getNextPosition: async () => 1,
        persist: async () => ({ fileWasInserted: false }),
        checkQuota: okQuota,
        chargeStorage,
      },
    );
    expect(chargeStorage).not.toHaveBeenCalled();
  });

  it('throws ImageStorageQuotaError (and does not upload) when over quota', async () => {
    const putObject = vi.fn(async () => undefined);
    await expect(
      createImageFilePage(
        { userId: 'u', buffer: buf, mimeType: 'image/png', title: 't' },
        {
          putObject,
          checkQuota: async () => ({ allowed: false, reason: 'Insufficient storage' }),
          resolveGalleryParent: async () => ({ driveId: 'd', parentId: 'p' }),
          getNextPosition: async () => 1,
          persist: async () => ({ fileWasInserted: true }),
        },
      ),
    ).rejects.toBeInstanceOf(ImageStorageQuotaError);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('files into an explicit target location when provided (no gallery lookup)', async () => {
    const resolveGalleryParent = vi.fn(async () => ({ driveId: 'home1', parentId: 'gallery1' }));
    const out = await createImageFilePage(
      { userId: 'u', buffer: buf, mimeType: 'image/png', title: 't', targetDriveId: 'driveX', targetParentId: 'pageY' },
      {
        putObject: async () => undefined,
        resolveGalleryParent,
        getNextPosition: async () => 1,
        persist: async () => ({ fileWasInserted: true }),
        checkQuota: okQuota,
        chargeStorage: async () => {},
      },
    );
    assert({
      given: 'a target drive + parent',
      should: 'use them and skip the gallery resolver',
      actual: { driveId: out.driveId, parentId: out.parentId, galleryCalled: resolveGalleryParent.mock.calls.length },
      expected: { driveId: 'driveX', parentId: 'pageY', galleryCalled: 0 },
    });
  });

  it('exposes the gallery folder name', () => {
    expect(GENERATED_IMAGES_FOLDER).toBe('Generated Images');
  });
});

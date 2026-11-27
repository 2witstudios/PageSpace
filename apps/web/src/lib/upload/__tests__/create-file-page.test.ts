import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '@/test/riteway';
import {
  sha256Hex,
  buildImageFilePageValues,
  createImageFilePage,
  createFilePage,
  buildFilePageValues,
  mimeTypeForFileName,
  FileStorageQuotaError,
  imageFileName,
  GENERATED_IMAGES_FOLDER,
  ImageStorageQuotaError,
  type FilePageWrite,
} from '../create-file-page';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';

const mockAssertUploadNotBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/upload-gate', () => ({
  assertUploadNotBlocked: (...args: unknown[]) => mockAssertUploadNotBlocked(...args),
}));

beforeEach(() => {
  mockAssertUploadNotBlocked.mockReset();
  mockAssertUploadNotBlocked.mockResolvedValue(undefined);
});

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

  // targetDriveId alone used to mean "that drive's ROOT". It now means "that
  // drive's Generated Images folder", so an image filed into a work drive lands
  // somewhere just as tidy as one filed into Home.
  it('routes a drive-only target through the gallery resolver for THAT drive', async () => {
    const resolveGalleryParent = vi.fn(async () => ({ driveId: 'driveX', parentId: 'galleryX' }));
    const out = await createImageFilePage(
      { userId: 'u', buffer: buf, mimeType: 'image/png', title: 't', targetDriveId: 'driveX' },
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
      given: 'a target drive with no parent',
      should: "resolve that drive's gallery folder",
      actual: {
        driveId: out.driveId,
        parentId: out.parentId,
        galleryArgs: resolveGalleryParent.mock.calls[0],
      },
      expected: { driveId: 'driveX', parentId: 'galleryX', galleryArgs: ['u', 'driveX'] },
    });
  });

  it('rejects a parent with no drive, rather than guessing which drive it is in', async () => {
    await expect(
      createImageFilePage(
        { userId: 'u', buffer: buf, mimeType: 'image/png', title: 't', targetParentId: 'pageY' },
        {
          putObject: async () => undefined,
          resolveGalleryParent: async () => ({ driveId: 'home1', parentId: 'gallery1' }),
          getNextPosition: async () => 1,
          persist: async () => ({ fileWasInserted: true }),
          checkQuota: okQuota,
          chargeStorage: async () => {},
        },
      ),
    ).rejects.toThrow('targetDriveId is required when targetParentId is provided');
  });

  it('exposes the gallery folder name', () => {
    expect(GENERATED_IMAGES_FOLDER).toBe('Generated Images');
  });
});

describe('createImageFilePage — content blocklist', () => {
  const deps = () => ({
    putObject: vi.fn(async () => undefined),
    resolveGalleryParent: async () => ({ driveId: 'd', parentId: 'p' }),
    getNextPosition: async () => 1,
    persist: vi.fn(async () => ({ fileWasInserted: true })),
    checkQuota: async () => ({ allowed: true }),
    chargeStorage: vi.fn(async () => {}),
  });

  it('throws ContentBlockedError and writes no bytes or rows when the generated bytes are blocked', async () => {
    mockAssertUploadNotBlocked.mockRejectedValue(new ContentBlockedError(HASH));
    const d = deps();

    await expect(
      createImageFilePage({ userId: 'u', buffer: buf, mimeType: 'image/png', title: 't' }, d),
    ).rejects.toBeInstanceOf(ContentBlockedError);

    expect(d.putObject).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
    expect(d.chargeStorage).not.toHaveBeenCalled();
  });

  it('checks the hash of the bytes themselves, with the user and target drive', async () => {
    await createImageFilePage(
      { userId: 'u', buffer: buf, mimeType: 'image/png', title: 't', targetDriveId: 'driveX' },
      deps(),
    );

    expect(mockAssertUploadNotBlocked).toHaveBeenCalledWith({
      contentHash: HASH,
      userId: 'u',
      entryPoint: 'image-generation',
      details: { driveId: 'driveX' },
    });
  });

  it('leaves unblocked bytes unaffected', async () => {
    const d = deps();

    const out = await createImageFilePage({ userId: 'u', buffer: buf, mimeType: 'image/png', title: 't' }, d);

    expect(out.driveId).toBe('d');
    expect(d.putObject).toHaveBeenCalledTimes(1);
  });
});

describe('buildFilePageValues (pure) — a sandbox file filed into the drive', () => {
  const now = new Date('2026-11-26T00:00:00.000Z');
  const v = buildFilePageValues({
    pageId: 'page2', contentHash: HASH, driveId: 'drive1', parentId: 'folder1',
    title: 'exhibits-ocr.pdf', mimeType: 'application/pdf', fileSize: buf.length, userId: 'user1',
    position: 0, source: 'sandbox-copy', now,
  });

  it('is PENDING, so the processor verifies and extracts it like any upload', () => {
    // Unlike a generated image, an agent's file is not a known-final artifact:
    // it needs the same Magika gate and text extraction an upload gets.
    assert({
      given: 'a sandbox-copy FILE page',
      should: 'start pending with no extraction method claimed',
      actual: { type: v.type, processingStatus: v.processingStatus, extractionMethod: v.extractionMethod ?? null },
      expected: { type: 'FILE', processingStatus: 'pending', extractionMethod: null },
    });
  });

  it('keeps the title as the download name and records where it came from', () => {
    assert({
      given: 'a sandbox file titled with its extension',
      should: 'use the title as originalFileName and stamp the source',
      actual: { name: v.originalFileName, source: (v.fileMetadata as Record<string, unknown>).source },
      expected: { name: 'exhibits-ocr.pdf', source: 'sandbox-copy' },
    });
  });
});

describe('mimeTypeForFileName (pure)', () => {
  it('maps common extensions, case-insensitively, and falls back to octet-stream', () => {
    assert({
      given: 'a set of names',
      should: 'map each to its media type',
      actual: ['a.pdf', 'b.PNG', 'c.jpeg', 'd.csv', 'e.docx', 'f.zip', 'g', 'h.unknownext'].map(mimeTypeForFileName),
      expected: [
        'application/pdf',
        'image/png',
        'image/jpeg',
        'text/csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/zip',
        'application/octet-stream',
        'application/octet-stream',
      ],
    });
  });
});

describe('createFilePage — the generalized shell, sandbox-copy flavour', () => {
  const okQuota = vi.fn(async (_u: string, _b: number) => ({ allowed: true }));

  function deps() {
    const order: string[] = [];
    return {
      order,
      storeOriginal: vi.fn(async (_args: { contentHash: string; pageId: string; driveId: string; parentId: string | null }) => { order.push('store'); }),
      putObject: vi.fn(async () => { order.push('put'); }),
      getNextPosition: vi.fn(async () => 2),
      persist: vi.fn(async (_w: FilePageWrite) => { order.push('persist'); return { fileWasInserted: true }; }),
      checkQuota: okQuota,
      chargeStorage: vi.fn(async () => { order.push('charge'); }),
      afterCommit: vi.fn(async (_a: { pageId: string; driveId: string }) => { order.push('afterCommit'); }),
    };
  }

  const input = {
    userId: 'u1',
    buffer: buf,
    mimeType: 'application/pdf',
    title: 'out.pdf',
    source: 'sandbox-copy' as const,
    targetDriveId: 'driveX',
    targetParentId: 'folderY',
  };

  it('stores the bytes through the injected store (the processor), never a bare S3 put, BEFORE any row exists', async () => {
    const d = deps();
    const out = await createFilePage(input, d);
    expect(d.putObject).not.toHaveBeenCalled();
    expect(d.storeOriginal).toHaveBeenCalledTimes(1);
    const stored = d.storeOriginal.mock.calls[0][0];
    // The store is told the page id the row will carry, so a page-bound token can be minted for it.
    expect(stored).toMatchObject({ contentHash: HASH, pageId: out.pageId, driveId: 'driveX', parentId: 'folderY' });
    expect(d.order.indexOf('store')).toBeLessThan(d.order.indexOf('persist'));
  });

  it('inserts files/pages/filePages with the sandbox-copy link source, pending, then runs afterCommit (the processor enqueue)', async () => {
    const d = deps();
    const out = await createFilePage(input, d);
    const written = d.persist.mock.calls[0][0];
    expect(written.fileRow).toMatchObject({ id: HASH, driveId: 'driveX', sizeBytes: buf.length, mimeType: 'application/pdf' });
    expect(written.pageValues).toMatchObject({ id: out.pageId, processingStatus: 'pending', parentId: 'folderY', driveId: 'driveX' });
    expect(written.junction).toMatchObject({ fileId: HASH, pageId: out.pageId, linkSource: 'sandbox-copy' });
    expect(d.afterCommit).toHaveBeenCalledWith({ pageId: out.pageId, driveId: 'driveX' });
    expect(d.order.indexOf('afterCommit')).toBeGreaterThan(d.order.indexOf('persist'));
  });

  it('charges storage on first store, against the target drive', async () => {
    const d = deps();
    const out = await createFilePage(input, d);
    expect(d.chargeStorage).toHaveBeenCalledWith('u1', buf.length, { pageId: out.pageId, driveId: 'driveX', eventType: 'upload' });
  });

  it('checks the blocklist under the sandbox-copy entry point', async () => {
    await createFilePage(input, deps());
    expect(mockAssertUploadNotBlocked).toHaveBeenCalledWith({
      contentHash: HASH,
      userId: 'u1',
      entryPoint: 'sandbox-copy',
      details: { driveId: 'driveX' },
    });
  });

  it('given a quota refusal, should throw FileStorageQuotaError and store nothing', async () => {
    const d = { ...deps(), checkQuota: async () => ({ allowed: false, reason: 'File exceeds pro tier limit of 250 MB' }) };
    await expect(createFilePage(input, d)).rejects.toBeInstanceOf(FileStorageQuotaError);
    expect(d.storeOriginal).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('given a store failure, should write no rows', async () => {
    const d = { ...deps(), storeOriginal: vi.fn(async () => { throw new Error('processor down'); }) };
    await expect(createFilePage(input, d)).rejects.toThrow('processor down');
    expect(d.persist).not.toHaveBeenCalled();
  });

  it('given an afterCommit failure, should still return the committed page (best-effort, like the upload route)', async () => {
    const d = { ...deps(), afterCommit: vi.fn(async () => { throw new Error('enqueue failed'); }) };
    const out = await createFilePage(input, d);
    expect(out.driveId).toBe('driveX');
  });

  it('the image wrapper is the same shell and its quota error is the same class', () => {
    expect(ImageStorageQuotaError).toBe(FileStorageQuotaError);
  });
});

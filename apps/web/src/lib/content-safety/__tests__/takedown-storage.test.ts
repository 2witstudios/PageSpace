import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeS3 } from '@/test/fake-s3';

const fakeS3 = vi.hoisted(() => ({ current: null as null | { send(command: unknown): Promise<unknown> } }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send(command: unknown) {
      return fakeS3.current!.send(command);
    }
  },
}));

import { createTakedownStorage, getEvidenceBucket } from '../takedown-storage';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const UPLOADS = 'test-uploads';
const PUBLISH = 'test-published';
const EVIDENCE = 'test-evidence';

let s3: FakeS3;

beforeEach(() => {
  s3 = new FakeS3();
  fakeS3.current = s3;
  vi.stubEnv('BUCKET_NAME', UPLOADS);
  vi.stubEnv('PUBLISH_BUCKET', PUBLISH);
  vi.stubEnv('EVIDENCE_BUCKET', EVIDENCE);

  s3.put(UPLOADS, `files/${HASH}/original`, 'original-bytes', 'image/png');
  s3.put(UPLOADS, `files/${HASH}/original.meta.json`, '{}');
  s3.put(UPLOADS, `cache/${HASH}/thumbnail.webp`, 'thumb');
  s3.put(UPLOADS, `cache/${HASH}/extracted.txt`, 'text');
  s3.put(UPLOADS, `chat-attachments/${HASH}/original`, 'original-bytes');
  s3.put(UPLOADS, `files/${OTHER}/original`, 'someone else');
  s3.put(UPLOADS, `avatars/u1/avatar.png`, 'avatar');
  s3.put(PUBLISH, `assets/${HASH}`, 'original-bytes', 'image/png');
  s3.put(PUBLISH, `assets/cache/${HASH}/thumbnail.webp`, 'thumb');
  s3.put(PUBLISH, `assets/${OTHER}`, 'someone else');
  s3.put(PUBLISH, `published/site/index.html`, '<html>');
});

describe('evidence bucket configuration', () => {
  it('is configured only when EVIDENCE_BUCKET is set', () => {
    expect(createTakedownStorage().evidenceConfigured()).toBe(true);
    vi.stubEnv('EVIDENCE_BUCKET', '');
    expect(createTakedownStorage().evidenceConfigured()).toBe(false);
    expect(getEvidenceBucket()).toBeNull();
  });

  it('refuses to use the public publish bucket for evidence', () => {
    vi.stubEnv('EVIDENCE_BUCKET', PUBLISH);
    expect(() => createTakedownStorage().evidenceConfigured()).toThrow(/must not be the public publish bucket/);
  });
});

describe('findOriginal', () => {
  it('prefers the page-file original', async () => {
    expect(await createTakedownStorage().findOriginal(HASH)).toEqual({
      store: 'uploads',
      key: `files/${HASH}/original`,
      size: 'original-bytes'.length,
    });
  });

  it('falls back to the chat attachment, then to the public asset', async () => {
    const storage = createTakedownStorage();
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    expect(await storage.findOriginal(HASH)).toMatchObject({ store: 'uploads', key: `chat-attachments/${HASH}/original` });

    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    expect(await storage.findOriginal(HASH)).toMatchObject({ store: 'publish', key: `assets/${HASH}` });

    s3.bucket(PUBLISH).delete(`assets/${HASH}`);
    expect(await storage.findOriginal(HASH)).toBeNull();
  });

  it('throws rather than reporting "nothing to preserve" when storage cannot be read', async () => {
    s3.failOn = { match: 'HeadObjectCommand', error: new Error('503 Slow Down') };
    await expect(createTakedownStorage().findOriginal(HASH)).rejects.toThrow('503 Slow Down');
  });

  it('rejects a value that is not a content hash', async () => {
    await expect(createTakedownStorage().findOriginal('../etc')).rejects.toThrow('Invalid content hash');
  });
});

describe('copyToEvidence', () => {
  const evidenceKey = `cases/case-1/${HASH}/original`;

  it('copies the private original into the evidence bucket and can verify its size', async () => {
    const storage = createTakedownStorage();
    const source = (await storage.findOriginal(HASH))!;
    expect(await storage.headEvidence(evidenceKey)).toBeNull();

    await storage.copyToEvidence(source, evidenceKey);

    expect(await storage.headEvidence(evidenceKey)).toEqual({ size: source.size });
    expect(s3.keys(EVIDENCE)).toEqual([evidenceKey]);
    expect(s3.has(UPLOADS, `files/${HASH}/original`)).toBe(true);
  });

  it('copies from the public bucket when that is the only copy left', async () => {
    const storage = createTakedownStorage();
    await storage.copyToEvidence({ store: 'publish', key: `assets/${HASH}`, size: 14 }, evidenceKey);
    expect(await storage.headEvidence(evidenceKey)).toEqual({ size: 'original-bytes'.length });
  });

  it('fails when no evidence bucket is configured', async () => {
    vi.stubEnv('EVIDENCE_BUCKET', '');
    await expect(
      createTakedownStorage().copyToEvidence({ store: 'uploads', key: `files/${HASH}/original`, size: 1 }, evidenceKey),
    ).rejects.toThrow('EVIDENCE_BUCKET is not configured');
  });
});

describe('deleteFromUploads', () => {
  it('deletes files/, cache/ and chat-attachments/ for the hash and nothing else', async () => {
    const deleted = await createTakedownStorage().deleteFromUploads(HASH);

    expect(deleted).toBe(5);
    expect(s3.keys(UPLOADS)).toEqual([`avatars/u1/avatar.png`, `files/${OTHER}/original`]);
  });

  it('is a no-op the second time', async () => {
    const storage = createTakedownStorage();
    await storage.deleteFromUploads(HASH);
    expect(await storage.deleteFromUploads(HASH)).toBe(0);
  });

  it('never calls the processor', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await createTakedownStorage().deleteFromUploads(HASH);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('deleteFromPublish', () => {
  it('deletes assets/<hash> and assets/cache/<hash>/*, leaving other assets and published sites', async () => {
    const deleted = await createTakedownStorage().deleteFromPublish(HASH);

    expect(deleted).toBe(2);
    expect(s3.keys(PUBLISH)).toEqual([`assets/${OTHER}`, `published/site/index.html`]);
  });

  it('is a no-op the second time, and when publishing is not configured', async () => {
    const storage = createTakedownStorage();
    await storage.deleteFromPublish(HASH);
    expect(await storage.deleteFromPublish(HASH)).toBe(0);

    vi.stubEnv('PUBLISH_BUCKET', '');
    expect(await createTakedownStorage().deleteFromPublish(OTHER)).toBe(0);
  });
});

describe('hasAnyObjects', () => {
  it('sees derived objects even after both originals are gone', async () => {
    const storage = createTakedownStorage();
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    s3.bucket(UPLOADS).delete(`files/${HASH}/original.meta.json`);
    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    s3.bucket(PUBLISH).delete(`assets/${HASH}`);
    expect(await storage.hasAnyObjects(HASH)).toBe(true);

    s3.bucket(UPLOADS).delete(`cache/${HASH}/thumbnail.webp`);
    s3.bucket(UPLOADS).delete(`cache/${HASH}/extracted.txt`);
    expect(await storage.hasAnyObjects(HASH)).toBe(true);

    s3.bucket(PUBLISH).delete(`assets/cache/${HASH}/thumbnail.webp`);
    expect(await storage.hasAnyObjects(HASH)).toBe(false);
  });
});

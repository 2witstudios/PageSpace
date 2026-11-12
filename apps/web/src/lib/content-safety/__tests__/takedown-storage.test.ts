import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { encryptBuffer } from '@pagespace/lib/encryption/envelope-crypto';
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

const CASE = 'case-1';
const HOLD = `content-hold/${CASE}/${HASH}`;

describe('findOriginal', () => {
  it('prefers the page-file original', async () => {
    expect(await createTakedownStorage().findOriginal(HASH, CASE)).toEqual({
      key: `files/${HASH}/original`,
      size: 'original-bytes'.length,
    });
  });

  it('falls back to the chat attachment, then to this case\'s private hold copy, and never to the public bucket', async () => {
    const storage = createTakedownStorage();
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    expect(await storage.findOriginal(HASH, CASE)).toMatchObject({ key: `chat-attachments/${HASH}/original` });

    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    expect(await storage.findOriginal(HASH, CASE)).toBeNull();

    s3.put(UPLOADS, HOLD, 'original-bytes');
    expect(await storage.findOriginal(HASH, CASE)).toEqual({ key: HOLD, size: 'original-bytes'.length });
    expect(await storage.findOriginal(HASH, 'another-case')).toBeNull();
  });

  it('throws rather than reporting "nothing to preserve" when storage cannot be read', async () => {
    s3.failOn = { match: 'HeadObjectCommand', error: new Error('503 Slow Down') };
    await expect(createTakedownStorage().findOriginal(HASH, CASE)).rejects.toThrow('503 Slow Down');
  });

  it('rejects a value that is not a content hash', async () => {
    await expect(createTakedownStorage().findOriginal('../etc', CASE)).rejects.toThrow('Invalid content hash');
  });
});

describe('takePublicOffline', () => {
  it('deletes the public asset and its thumbnail at once when a private original exists, making no extra copy', async () => {
    const result = await createTakedownStorage().takePublicOffline(HASH, CASE);

    expect(result).toEqual({ deleted: 2, held: false });
    expect(s3.keys(PUBLISH)).toEqual([`assets/${OTHER}`, `published/site/index.html`]);
    expect(s3.has(UPLOADS, HOLD)).toBe(false);
    expect(s3.has(UPLOADS, `files/${HASH}/original`)).toBe(true);
  });

  it('copies a public-only file into the PRIVATE uploads bucket before deleting its public key', async () => {
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);

    const result = await createTakedownStorage().takePublicOffline(HASH, CASE);

    expect(result).toEqual({ deleted: 2, held: true });
    expect(new TextDecoder().decode(s3.bucket(UPLOADS).get(HOLD)!.body)).toBe('original-bytes');
    expect(s3.keys(PUBLISH)).toEqual([`assets/${OTHER}`, `published/site/index.html`]);
    const put = s3.log.findIndex((line) => line === `PutObjectCommand ${UPLOADS} ${HOLD}`);
    const firstPublicDelete = s3.log.findIndex((line) => line.startsWith('Delete') && line.includes(PUBLISH));
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(firstPublicDelete);
  });

  it('does not trust an earlier hold copy of the same size but different bytes: it is written again', async () => {
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    s3.put(UPLOADS, HOLD, 'Xriginal-bytes');

    await createTakedownStorage().takePublicOffline(HASH, CASE);

    expect(new TextDecoder().decode(s3.bucket(UPLOADS).get(HOLD)!.body)).toBe('original-bytes');
  });

  it('parks nothing in the publish bucket: no key is written there at all', async () => {
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    await createTakedownStorage().takePublicOffline(HASH, CASE);

    expect(s3.log.some((line) => /^(Put|Copy)ObjectCommand/.test(line) && line.includes(PUBLISH))).toBe(false);
  });

  it('leaves the public object in place when the private copy cannot be written', async () => {
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    s3.failOn = { match: `PutObjectCommand ${UPLOADS}`, error: new Error('put failed') };

    await expect(createTakedownStorage().takePublicOffline(HASH, CASE)).rejects.toThrow('put failed');
    expect(s3.has(PUBLISH, `assets/${HASH}`)).toBe(true);
  });

  it('is a no-op the second time, and when publishing is not configured', async () => {
    const storage = createTakedownStorage();
    await storage.takePublicOffline(HASH, CASE);
    expect(await storage.takePublicOffline(HASH, CASE)).toEqual({ deleted: 0, held: false });

    vi.stubEnv('PUBLISH_BUCKET', '');
    expect(await createTakedownStorage().takePublicOffline(OTHER, CASE)).toEqual({ deleted: 0, held: false });
  });
});

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('digestSource / digestEvidence', () => {
  const MASTER_KEY = 'file-master-key-at-least-32-characters-long!';

  it('hashes the whole object as stored; for a plaintext object that is also the content hash', async () => {
    const digest = await createTakedownStorage().digestSource(`files/${HASH}/original`);
    expect(digest).toEqual({ size: 'original-bytes'.length, sha256: sha('original-bytes'), contentSha256: sha('original-bytes') });
  });

  it('tells two objects of the same size apart', async () => {
    s3.put(UPLOADS, 'files/x/a', 'aaaa');
    s3.put(UPLOADS, 'files/x/b', 'aaab');
    const storage = createTakedownStorage();
    const [a, b] = await Promise.all([storage.digestSource('files/x/a'), storage.digestSource('files/x/b')]);
    expect(a!.size).toBe(b!.size);
    expect(a!.sha256).not.toBe(b!.sha256);
  });

  it('hashes the content behind an at-rest envelope, so an encrypted original still matches its content hash', async () => {
    vi.stubEnv('ENCRYPTION_KEY', MASTER_KEY);
    const stored = encryptBuffer(Buffer.from('original-bytes'), MASTER_KEY);
    s3.put(UPLOADS, `files/${HASH}/original`, stored);

    const digest = await createTakedownStorage().digestSource(`files/${HASH}/original`);

    expect(digest).toEqual({ size: stored.length, sha256: sha(stored), contentSha256: sha('original-bytes') });
  });

  it('fails, rather than guesses, on an envelope it cannot open', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a-different-key-that-is-also-32-chars-long');
    s3.put(UPLOADS, `files/${HASH}/original`, encryptBuffer(Buffer.from('original-bytes'), MASTER_KEY));
    await expect(createTakedownStorage().digestSource(`files/${HASH}/original`)).rejects.toThrow();
  });

  it('reads the evidence bucket for evidence, and returns null only for a missing object', async () => {
    const storage = createTakedownStorage();
    expect(await storage.digestEvidence('cases/c/h/original')).toBeNull();
    s3.put(EVIDENCE, 'cases/c/h/original', 'kept');
    expect(await storage.digestEvidence('cases/c/h/original')).toMatchObject({ sha256: sha('kept') });

    s3.failOn = { match: `GetObjectCommand ${EVIDENCE}`, error: new Error('503 Slow Down') };
    await expect(storage.digestEvidence('cases/c/h/original')).rejects.toThrow('503 Slow Down');
  });
});

describe('copyToEvidence', () => {
  const evidenceKey = `cases/${CASE}/${HASH}/original`;

  it('copies the private original into the evidence bucket, byte for byte', async () => {
    const storage = createTakedownStorage();
    const source = (await storage.findOriginal(HASH, CASE))!;
    expect(await storage.digestEvidence(evidenceKey)).toBeNull();

    await storage.copyToEvidence(source, evidenceKey);

    expect(await storage.digestEvidence(evidenceKey)).toEqual(await storage.digestSource(source.key));
    expect(s3.keys(EVIDENCE)).toEqual([evidenceKey]);
    expect(s3.has(UPLOADS, `files/${HASH}/original`)).toBe(true);
  });

  it('copies from the private hold copy when the file was public-only', async () => {
    const storage = createTakedownStorage();
    s3.bucket(UPLOADS).delete(`files/${HASH}/original`);
    s3.bucket(UPLOADS).delete(`chat-attachments/${HASH}/original`);
    await storage.takePublicOffline(HASH, CASE);

    await storage.copyToEvidence((await storage.findOriginal(HASH, CASE))!, evidenceKey);
    expect(await storage.digestEvidence(evidenceKey)).toMatchObject({ sha256: sha('original-bytes') });
  });

  it('fails when no evidence bucket is configured', async () => {
    vi.stubEnv('EVIDENCE_BUCKET', '');
    await expect(
      createTakedownStorage().copyToEvidence({ key: `files/${HASH}/original`, size: 1 }, evidenceKey),
    ).rejects.toThrow('EVIDENCE_BUCKET is not configured');
  });
});

describe('deleteFromUploads', () => {
  it('deletes files/, cache/ and chat-attachments/ for the hash and nothing else', async () => {
    const deleted = await createTakedownStorage().deleteFromUploads(HASH, CASE);

    expect(deleted).toBe(5);
    expect(s3.keys(UPLOADS)).toEqual([`avatars/u1/avatar.png`, `files/${OTHER}/original`]);
  });

  it('also deletes this case\'s hold copy, and not another case\'s', async () => {
    s3.put(UPLOADS, HOLD, 'original-bytes');
    s3.put(UPLOADS, `content-hold/another-case/${HASH}`, 'original-bytes');

    expect(await createTakedownStorage().deleteFromUploads(HASH, CASE)).toBe(6);
    expect(s3.has(UPLOADS, HOLD)).toBe(false);
    expect(s3.has(UPLOADS, `content-hold/another-case/${HASH}`)).toBe(true);
  });

  it('is a no-op the second time', async () => {
    const storage = createTakedownStorage();
    await storage.deleteFromUploads(HASH, CASE);
    expect(await storage.deleteFromUploads(HASH, CASE)).toBe(0);
  });

  it('never calls the processor', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await createTakedownStorage().deleteFromUploads(HASH, CASE);
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

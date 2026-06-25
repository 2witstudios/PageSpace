/**
 * ContentStore at-rest encryption wiring (GDPR #966 + #973).
 *
 * - Originals & browser-served binary cache objects are encrypted only when
 *   FILE_ENCRYPTION_ENABLED (default OFF) so presigned-URL delivery is
 *   unaffected on cloud.
 * - Server-side-only text caches (extracted-text.txt, ocr-text.txt) are
 *   encrypted whenever a key exists, regardless of the flag (#973) — they are
 *   never browser-presigned and are decrypted by serve.ts.
 * - Reads transparently decrypt envelopes and pass legacy plaintext through.
 */
import { describe, it, expect, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(() => ({ done: vi.fn().mockResolvedValue({}) })),
}));

import { ContentStore } from '../content-store';
import { isEnvelope } from '../envelope-crypto';

const BUCKET = 'test-bucket';
const KEY = 'content-store-master-key-at-least-32-chars!!';

function makeBody(buf: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(buf);
    },
  };
}

/** S3 mock: PutObject stores by Key; GetObject echoes the stored bytes. */
function createStore(encryption: { enabled: boolean; masterKey: string }) {
  const objects = new Map<string, Buffer>();
  const send = vi.fn(async (command: { input: { Key: string; Body?: Buffer } }) => {
    const { Key, Body } = command.input;
    if (Body !== undefined) {
      objects.set(Key, Buffer.isBuffer(Body) ? Body : Buffer.from(Body));
      return {};
    }
    const stored = objects.get(Key);
    if (!stored) {
      throw Object.assign(new Error('Not found'), { name: 'NoSuchKey' });
    }
    return { Body: makeBody(stored) };
  });
  const s3 = { send } as unknown as S3Client;
  const store = new ContentStore(s3, BUCKET, encryption);
  return { store, objects };
}

describe('ContentStore originals encryption (#966)', () => {
  it('given encryption enabled, should store an envelope and decrypt on read', async () => {
    const { store, objects } = createStore({ enabled: true, masterKey: KEY });
    const plain = Buffer.from('top secret document bytes');
    const { contentHash } = await store.saveOriginal(plain, 'doc.pdf');

    const stored = objects.get(`files/${contentHash}/original`)!;
    expect(isEnvelope(stored)).toBe(true);
    expect(stored.equals(plain)).toBe(false);

    const read = await store.getOriginal(contentHash);
    expect(read!.equals(plain)).toBe(true);
  });

  it('given encryption disabled, should store plaintext (presigned delivery unaffected)', async () => {
    const { store, objects } = createStore({ enabled: false, masterKey: KEY });
    const plain = Buffer.from('plaintext original');
    const { contentHash } = await store.saveOriginal(plain, 'a.bin');
    expect(objects.get(`files/${contentHash}/original`)!.equals(plain)).toBe(true);
  });
});

describe('ContentStore extracted-text encryption (#973)', () => {
  it('given a server-side text preset, should encrypt even when flag is OFF', async () => {
    const { store, objects } = createStore({ enabled: false, masterKey: KEY });
    const hash = 'b'.repeat(64);
    const text = Buffer.from('extracted PII document text');
    await store.saveCache(hash, 'extracted-text.txt', text, 'text/plain');

    const stored = objects.get(`cache/${hash}/extracted-text.txt`)!;
    expect(isEnvelope(stored)).toBe(true);

    const read = await store.getCache(hash, 'extracted-text.txt');
    expect(read!.equals(text)).toBe(true);
  });

  it('given a browser-served binary preset with flag OFF, should store plaintext', async () => {
    const { store, objects } = createStore({ enabled: false, masterKey: KEY });
    const hash = 'c'.repeat(64);
    const img = Buffer.from('thumbnail-bytes');
    await store.saveCache(hash, 'thumbnail.webp', img, 'image/webp');
    expect(objects.get(`cache/${hash}/thumbnail.webp`)!.equals(img)).toBe(true);
  });
});

describe('ContentStore legacy plaintext reads', () => {
  it('given a plaintext original written before encryption, should read it back', async () => {
    const { store, objects } = createStore({ enabled: true, masterKey: KEY });
    const hash = 'd'.repeat(64);
    objects.set(`files/${hash}/original`, Buffer.from('legacy plaintext'));
    const read = await store.getOriginal(hash);
    expect(read!.toString()).toBe('legacy plaintext');
  });
});

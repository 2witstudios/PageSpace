import { describe, expect, it, vi } from 'vitest';
import { createHiveScanner, mapHiveResponse } from '../scanner-hive';

/**
 * Fixtures follow the shape of the examples in Hive's "CSAM Detection -
 * Combined API" reference (status array → response.output.{file, hashes}).
 * They are written by hand, not recorded from the live API.
 */
const envelope = (output: unknown, code: number | string = 200) => ({
  status: [
    {
      status: { code, message: 'SUCCESS' },
      response: { input: { id: 'task-1', created_on: '2026-01-01T00:00:00Z', user_id: 1, project_id: 2 }, output },
    },
  ],
});

const CLEAN_IMAGE = envelope({
  file: { fileType: 'image', reasons: [], classifierPrediction: { csam_classifier: { pornography: 0.01, csam: 0.0001, other: 0.9899 } } },
  hashes: [],
});

const HASH_MATCH = envelope({
  file: { fileType: 'image', reasons: ['matched'], classifierPrediction: null },
  hashes: [
    {
      hashType: 'saferhashv0',
      hashString: null,
      matchTypes: ['CSAM'],
      reasons: ['matched'],
      sources: [{ hashSet: 'ncmec', matches: [{ sourceId: 's1', matchDistance: 44, matchMetadata: {}, matchTransformations: [] }] }],
      classifierPrediction: null,
      isLetterboxed: false,
      startTimestamp: null,
      endTimestamp: null,
      frameIndex: null,
    },
  ],
});

const TEST_SET_MATCH = envelope({
  file: { fileType: 'image', reasons: ['matched'], classifierPrediction: null },
  hashes: [{ hashType: 'saferhashv0', matchTypes: ['CSAM'], reasons: ['matched'], sources: [{ hashSet: 'test', matches: [] }] }],
});

const CLASSIFIER_HIT = envelope({
  file: { fileType: 'image', reasons: ['csam'], classifierPrediction: { csam_classifier: { pornography: 0.01, csam: 0.98, other: 0.01 } } },
  hashes: [],
});

const VIDEO_MATCH = envelope({
  file: { fileType: 'video', reasons: ['matched'], classifierPrediction: null },
  hashes: [
    { hashType: 'md5', matchTypes: ['CSAM', 'SE'], reasons: ['matched'], sources: [{ hashSet: 'list-a', matches: [] }, { hashSet: 'test-se', matches: [] }], startTimestamp: null, endTimestamp: null, frameIndex: null },
    { hashType: 'videoSaferhashv0', matchTypes: ['CSAM', 'SE'], reasons: ['matched'], sources: [{ hashSet: 'list-a', matches: [] }], startTimestamp: 4.0, endTimestamp: 5.2, frameIndex: 120 },
  ],
});

const VIDEO_CLEAN = envelope({ file: { fileType: 'video', reasons: [], classifierPrediction: null }, hashes: [] });

const options = { flagThreshold: 0.9 };

describe('mapHiveResponse', () => {
  it('maps a clean image with its classifier scores', () => {
    expect(mapHiveResponse(200, CLEAN_IMAGE, options)).toEqual({
      kind: 'clean',
      provider: 'hive',
      scores: { csam: 0.0001, pornography: 0.01, other: 0.9899 },
    });
  });

  it('maps a hash match to the list names and match types only', () => {
    expect(mapHiveResponse(200, HASH_MATCH, options)).toEqual({ kind: 'hash_match', provider: 'hive', lists: ['ncmec'], matchTypes: ['CSAM'] });
  });

  it('ignores Thorn test-list matches unless asked to count them', () => {
    expect(mapHiveResponse(200, TEST_SET_MATCH, options).kind).toBe('clean');
    expect(mapHiveResponse(200, TEST_SET_MATCH, { ...options, includeTestSets: true })).toMatchObject({ kind: 'hash_match', lists: ['test'] });
  });

  it('maps a classifier hit to a flag with its score', () => {
    expect(mapHiveResponse(200, CLASSIFIER_HIT, options)).toMatchObject({ kind: 'classifier_flag', category: 'csam', score: 0.98 });
  });

  it('flags on our threshold even when Hive lists no reason', () => {
    const body = envelope({ file: { reasons: [], classifierPrediction: { csam_classifier: { csam: 0.95, pornography: 0.03, other: 0.02 } } }, hashes: [] });
    expect(mapHiveResponse(200, body, options).kind).toBe('classifier_flag');
    expect(mapHiveResponse(200, body, { flagThreshold: 0.99 }).kind).toBe('clean');
  });

  it('maps a video match across hash entries, dropping test lists', () => {
    expect(mapHiveResponse(200, VIDEO_MATCH, options)).toEqual({ kind: 'hash_match', provider: 'hive', lists: ['list-a'], matchTypes: ['CSAM', 'SE'] });
  });

  it('maps a video with no match and no classifier output to clean without scores', () => {
    expect(mapHiveResponse(200, VIDEO_CLEAN, options)).toEqual({ kind: 'clean', provider: 'hive' });
  });

  it('reports HTTP failures by status code only', () => {
    expect(mapHiveResponse(429, { error: 'secret detail' }, options)).toEqual({ kind: 'error', provider: 'hive', reason: 'http_status', detail: '429' });
  });

  it('reports a vendor status that is not success', () => {
    expect(mapHiveResponse(200, { status: [{ status: { code: 500, message: 'ERROR' } }] }, options)).toMatchObject({ kind: 'error', reason: 'vendor_status' });
  });

  it('reports an unexpected body as bad_response, never as clean', () => {
    expect(mapHiveResponse(200, { hello: 'world' }, options)).toMatchObject({ kind: 'error', reason: 'bad_response' });
    expect(mapHiveResponse(200, null, options)).toMatchObject({ kind: 'error', reason: 'bad_response' });
  });

  it('treats a file-level match with no source as an error, not clean', () => {
    const body = envelope({ file: { reasons: ['matched'], classifierPrediction: null }, hashes: [] });
    expect(mapHiveResponse(200, body, options)).toMatchObject({ kind: 'error', reason: 'bad_response' });
  });
});

describe('createHiveScanner', () => {
  const input = { contentHash: 'a'.repeat(64), mediaKind: 'image' as const, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };

  it('posts the bytes as multipart `media` with a Token header, never a URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CLEAN_IMAGE), { status: 200 }));
    const scanner = createHiveScanner({ apiKey: 'key-1', flagThreshold: 0.9, fetchImpl });

    await expect(scanner.scan(input)).resolves.toMatchObject({ kind: 'clean' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.thehive.ai/api/v2/task/sync');
    expect(init.headers).toMatchObject({ Authorization: 'Token key-1' });
    const form = init.body as FormData;
    expect(form.get('media')).toBeInstanceOf(Blob);
    expect(form.get('url')).toBeNull();
  });

  it('refuses a type Hive does not support without calling it', async () => {
    const fetchImpl = vi.fn();
    const scanner = createHiveScanner({ apiKey: 'k', flagThreshold: 0.9, fetchImpl });
    await expect(scanner.scan({ ...input, contentType: 'image/bmp' })).resolves.toMatchObject({ kind: 'unsupported_type' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a network failure into an error result', async () => {
    const scanner = createHiveScanner({ apiKey: 'k', flagThreshold: 0.9, fetchImpl: vi.fn(async () => { throw new Error('ECONNRESET'); }) });
    await expect(scanner.scan(input)).resolves.toEqual({ kind: 'error', provider: 'hive', reason: 'network' });
  });

  it('turns an HTTP error with a non-JSON body into an http_status error', async () => {
    const scanner = createHiveScanner({ apiKey: 'k', flagThreshold: 0.9, fetchImpl: vi.fn(async () => new Response('nope', { status: 503 })) });
    await expect(scanner.scan(input)).resolves.toMatchObject({ kind: 'error', reason: 'http_status', detail: '503' });
  });
});

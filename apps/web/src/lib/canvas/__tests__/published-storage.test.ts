import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  buildPublishedKey,
  putPublishedArtifact,
  deletePublishedArtifact,
  isPublishConfigured,
  buildAssetKey,
  buildAssetUrl,
  buildAssetUrlFromKey,
  getPublishAssetBaseUrl,
  copyAssetToPublishBucket,
  copyObjectToPublishBucket,
} from '../published-storage';

const send = vi.fn();
const HASH = 'a'.repeat(64);

vi.mock('server-only', () => ({}));

// Mock only the S3Client constructor (capture .send); keep the real command
// classes so `instanceof` checks below still hold.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return { ...actual, S3Client: vi.fn(() => ({ send })) };
});

describe('buildPublishedKey', () => {
  it('maps the root path to a single index.html with no double slash', () => {
    expect(buildPublishedKey('acme', '')).toBe('published/acme/index.html');
  });

  it('maps a nested path under the subdomain prefix', () => {
    expect(buildPublishedKey('acme', 'about/team')).toBe(
      'published/acme/about/team/index.html',
    );
  });

  it('lowercases path segments', () => {
    expect(buildPublishedKey('acme', 'About/Team')).toBe(
      'published/acme/about/team/index.html',
    );
  });

  it('strips parent-traversal segments, collapsing to the root', () => {
    const key = buildPublishedKey('acme', '../../etc');
    expect(key).toBe('published/acme/etc/index.html');
    expect(key).not.toContain('..');
    expect(key.startsWith('published/acme/')).toBe(true);
  });

  it('keeps interleaved traversal attempts under the subdomain prefix', () => {
    const key = buildPublishedKey('acme', 'a/../../b');
    expect(key).toBe('published/acme/a/b/index.html');
    expect(key).not.toContain('..');
    expect(key.startsWith('published/acme/')).toBe(true);
  });

  it('treats a traversal-only path as root', () => {
    expect(buildPublishedKey('acme', '../..')).toBe('published/acme/index.html');
  });
});

describe('putPublishedArtifact', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    process.env.PUBLISH_BUCKET = 'test-bucket';
  });

  it('sends a PutObjectCommand with the right bucket, key, body, and content type', async () => {
    const result = await putPublishedArtifact({
      subdomain: 'acme',
      path: 'about/team',
      html: '<!doctype html><html></html>',
    });

    expect(result).toEqual({ key: 'published/acme/about/team/index.html' });
    expect(send).toHaveBeenCalledTimes(1);

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'published/acme/about/team/index.html',
      Body: '<!doctype html><html></html>',
      ContentType: 'text/html; charset=utf-8',
    });
  });
});

describe('deletePublishedArtifact', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    process.env.PUBLISH_BUCKET = 'test-bucket';
  });

  it('sends a DeleteObjectCommand with the right bucket and key', async () => {
    await deletePublishedArtifact('published/acme/index.html');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'published/acme/index.html',
    });
  });
});

describe('publish bucket configuration', () => {
  it('isPublishConfigured reflects PUBLISH_BUCKET presence', () => {
    const prev = process.env.PUBLISH_BUCKET;
    try {
      delete process.env.PUBLISH_BUCKET;
      expect(isPublishConfigured()).toBe(false);
      process.env.PUBLISH_BUCKET = 'pagespace-published';
      expect(isPublishConfigured()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PUBLISH_BUCKET;
      else process.env.PUBLISH_BUCKET = prev;
    }
  });

  it('putPublishedArtifact throws when PUBLISH_BUCKET is unset', async () => {
    const prev = process.env.PUBLISH_BUCKET;
    try {
      send.mockReset();
      delete process.env.PUBLISH_BUCKET;
      await expect(
        putPublishedArtifact({ subdomain: 'acme', path: '', html: '<html></html>' }),
      ).rejects.toThrow(/PUBLISH_BUCKET/);
      expect(send).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PUBLISH_BUCKET;
      else process.env.PUBLISH_BUCKET = prev;
    }
  });
});

describe('buildAssetKey', () => {
  it('given a contentHash, should return assets/{contentHash}', () => {
    expect(buildAssetKey(HASH)).toBe(`assets/${HASH}`);
  });

  it('given a 64-char SHA-256 hex hash, should return the correctly prefixed key', () => {
    const hash = 'a'.repeat(64);
    expect(buildAssetKey(hash)).toBe(`assets/${hash}`);
  });

  it('given a contentHash with path traversal, should reject it before building a public key', () => {
    expect(() => buildAssetKey('../private-secret')).toThrow(/content hash/i);
  });

  it('given a contentHash with a slash, should reject it before building a public key', () => {
    expect(() => buildAssetKey('abc123/original')).toThrow(/content hash/i);
  });
});

describe('getPublishAssetBaseUrl', () => {
  let origAssetUrl: string | undefined;
  let origBucket: string | undefined;

  beforeEach(() => {
    origAssetUrl = process.env.PUBLISH_ASSET_BASE_URL;
    origBucket = process.env.PUBLISH_BUCKET;
  });

  afterEach(() => {
    if (origAssetUrl === undefined) delete process.env.PUBLISH_ASSET_BASE_URL;
    else process.env.PUBLISH_ASSET_BASE_URL = origAssetUrl;
    if (origBucket === undefined) delete process.env.PUBLISH_BUCKET;
    else process.env.PUBLISH_BUCKET = origBucket;
  });

  it('given PUBLISH_ASSET_BASE_URL is set, should return it', () => {
    process.env.PUBLISH_ASSET_BASE_URL = 'https://cdn.example.com';
    expect(getPublishAssetBaseUrl()).toBe('https://cdn.example.com');
  });

  it('given PUBLISH_ASSET_BASE_URL unset but PUBLISH_BUCKET set, should derive Tigris public URL', () => {
    delete process.env.PUBLISH_ASSET_BASE_URL;
    process.env.PUBLISH_BUCKET = 'pagespace-published';
    expect(getPublishAssetBaseUrl()).toBe('https://pagespace-published.t3.tigrisfiles.io');
  });

  it('given both PUBLISH_ASSET_BASE_URL and PUBLISH_BUCKET set, should prefer PUBLISH_ASSET_BASE_URL', () => {
    process.env.PUBLISH_ASSET_BASE_URL = 'https://cdn.example.com';
    process.env.PUBLISH_BUCKET = 'pagespace-published';
    expect(getPublishAssetBaseUrl()).toBe('https://cdn.example.com');
  });

  it('given both unset, should throw a descriptive error', () => {
    delete process.env.PUBLISH_ASSET_BASE_URL;
    delete process.env.PUBLISH_BUCKET;
    expect(() => getPublishAssetBaseUrl()).toThrow(/PUBLISH_BUCKET/);
  });

  it('given PUBLISH_ASSET_BASE_URL is not HTTPS, should reject the public asset origin', () => {
    process.env.PUBLISH_ASSET_BASE_URL = 'http://cdn.example.com';
    expect(() => getPublishAssetBaseUrl()).toThrow(/HTTPS/i);
  });

  it('given PUBLISH_ASSET_BASE_URL includes credentials, should reject the public asset origin', () => {
    process.env.PUBLISH_ASSET_BASE_URL = 'https://user:pass@cdn.example.com';
    expect(() => getPublishAssetBaseUrl()).toThrow(/origin/i);
  });
});

describe('buildAssetUrl', () => {
  let origAssetUrl: string | undefined;
  let origBucket: string | undefined;

  beforeEach(() => {
    origAssetUrl = process.env.PUBLISH_ASSET_BASE_URL;
    origBucket = process.env.PUBLISH_BUCKET;
    process.env.PUBLISH_BUCKET = 'pagespace-published';
    delete process.env.PUBLISH_ASSET_BASE_URL;
  });

  afterEach(() => {
    if (origAssetUrl === undefined) delete process.env.PUBLISH_ASSET_BASE_URL;
    else process.env.PUBLISH_ASSET_BASE_URL = origAssetUrl;
    if (origBucket === undefined) delete process.env.PUBLISH_BUCKET;
    else process.env.PUBLISH_BUCKET = origBucket;
  });

  it('given a contentHash, should return the full public asset URL', () => {
    expect(buildAssetUrl(HASH)).toBe(`https://pagespace-published.t3.tigrisfiles.io/assets/${HASH}`);
  });

  it('given PUBLISH_ASSET_BASE_URL with trailing slash, should produce a clean URL without double slash', () => {
    process.env.PUBLISH_ASSET_BASE_URL = 'https://cdn.example.com/';
    expect(buildAssetUrl(HASH)).toBe(`https://cdn.example.com/assets/${HASH}`);
  });
});

describe('buildAssetUrlFromKey', () => {
  let origAssetUrl: string | undefined;
  let origBucket: string | undefined;

  beforeEach(() => {
    origAssetUrl = process.env.PUBLISH_ASSET_BASE_URL;
    origBucket = process.env.PUBLISH_BUCKET;
    process.env.PUBLISH_BUCKET = 'pagespace-published';
    delete process.env.PUBLISH_ASSET_BASE_URL;
  });

  afterEach(() => {
    if (origAssetUrl === undefined) delete process.env.PUBLISH_ASSET_BASE_URL;
    else process.env.PUBLISH_ASSET_BASE_URL = origAssetUrl;
    if (origBucket === undefined) delete process.env.PUBLISH_BUCKET;
    else process.env.PUBLISH_BUCKET = origBucket;
  });

  it('given a resolved asset key, should return the full public asset URL', () => {
    expect(buildAssetUrlFromKey('assets/cache/abc123/thumbnail.webp')).toBe(
      'https://pagespace-published.t3.tigrisfiles.io/assets/cache/abc123/thumbnail.webp',
    );
  });

  it('given an asset key outside the assets prefix, should reject it before building a public URL', () => {
    expect(() => buildAssetUrlFromKey('published/acme/index.html')).toThrow(/asset key/i);
  });

  it('given an asset key with traversal, should reject it before building a public URL', () => {
    expect(() => buildAssetUrlFromKey('assets/../published/acme/index.html')).toThrow(/asset key/i);
  });
});

describe('copyAssetToPublishBucket', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.PUBLISH_BUCKET = 'test-publish';
    process.env.BUCKET_NAME = 'test-files';
  });

  it('given the asset already exists in the publish bucket (HeadObject 200), should skip GetObject and PutObject', async () => {
    // HeadObject resolves → asset exists
    send.mockResolvedValueOnce({});

    await copyAssetToPublishBucket({ contentHash: HASH, mimeType: 'image/png' });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(HeadObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: 'test-publish', Key: `assets/${HASH}` });
  });

  it('given the asset does not exist in the publish bucket (HeadObject 404), should GetObject from private bucket then PutObject to publish bucket', async () => {
    const notFound = Object.assign(new Error('Not Found'), { name: 'NotFound' });
    const fakeBody = { transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])) };

    // HeadObject throws NotFound → GetObject succeeds → PutObject succeeds
    send
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ Body: fakeBody })
      .mockResolvedValueOnce({});

    await copyAssetToPublishBucket({ contentHash: HASH, mimeType: 'image/png' });

    expect(send).toHaveBeenCalledTimes(3);

    const [headCmd, getCmd, putCmd] = send.mock.calls.map((c) => c[0]);

    expect(headCmd).toBeInstanceOf(HeadObjectCommand);
    expect(headCmd.input).toMatchObject({ Bucket: 'test-publish', Key: `assets/${HASH}` });

    expect(getCmd).toBeInstanceOf(GetObjectCommand);
    expect(getCmd.input).toMatchObject({ Bucket: 'test-files', Key: `files/${HASH}/original` });

    expect(putCmd).toBeInstanceOf(PutObjectCommand);
    expect(putCmd.input).toMatchObject({
      Bucket: 'test-publish',
      Key: `assets/${HASH}`,
      ContentType: 'image/png',
    });
    expect(putCmd.input.Body).toBeInstanceOf(Uint8Array);
  });

  it('given HeadObject throws a non-404 error, should propagate the error without copying', async () => {
    const serverError = Object.assign(new Error('Server Error'), { name: 'ServiceUnavailable' });
    send.mockRejectedValueOnce(serverError);

    await expect(copyAssetToPublishBucket({ contentHash: HASH, mimeType: 'image/png' })).rejects.toThrow('Server Error');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('copyObjectToPublishBucket', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.PUBLISH_BUCKET = 'test-publish';
    process.env.BUCKET_NAME = 'test-files';
  });

  it('given a source key outside the private file/cache prefixes, should reject before any S3 command', async () => {
    await expect(copyObjectToPublishBucket({
      sourceKey: 'published/acme/index.html',
      assetKey: `assets/${HASH}`,
      contentType: 'text/html',
    })).rejects.toThrow(/source key/i);

    expect(send).not.toHaveBeenCalled();
  });

  it('given a public asset key with traversal, should reject before any S3 command', async () => {
    await expect(copyObjectToPublishBucket({
      sourceKey: `files/${HASH}/original`,
      assetKey: 'assets/../published/acme/index.html',
      contentType: 'image/png',
    })).rejects.toThrow(/asset key/i);

    expect(send).not.toHaveBeenCalled();
  });

  it('given a thumbnail cache object, should copy it to the requested public asset key', async () => {
    const notFound = Object.assign(new Error('Not Found'), { name: 'NotFound' });
    const fakeBody = { transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])) };

    send
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ Body: fakeBody })
      .mockResolvedValueOnce({});

    await copyObjectToPublishBucket({
      sourceKey: 'cache/abc123/thumbnail.webp',
      assetKey: 'assets/cache/abc123/thumbnail.webp',
      contentType: 'image/webp',
    });

    expect(send).toHaveBeenCalledTimes(3);

    const [headCmd, getCmd, putCmd] = send.mock.calls.map((c) => c[0]);

    expect(headCmd).toBeInstanceOf(HeadObjectCommand);
    expect(headCmd.input).toMatchObject({
      Bucket: 'test-publish',
      Key: 'assets/cache/abc123/thumbnail.webp',
    });

    expect(getCmd).toBeInstanceOf(GetObjectCommand);
    expect(getCmd.input).toMatchObject({
      Bucket: 'test-files',
      Key: 'cache/abc123/thumbnail.webp',
    });

    expect(putCmd).toBeInstanceOf(PutObjectCommand);
    expect(putCmd.input).toMatchObject({
      Bucket: 'test-publish',
      Key: 'assets/cache/abc123/thumbnail.webp',
      ContentType: 'image/webp',
    });
  });
});

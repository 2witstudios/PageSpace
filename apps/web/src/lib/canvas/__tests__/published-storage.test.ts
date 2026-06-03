import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  buildPublishedKey,
  putPublishedArtifact,
  deletePublishedArtifact,
  isPublishConfigured,
} from '../published-storage';

const send = vi.fn();

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

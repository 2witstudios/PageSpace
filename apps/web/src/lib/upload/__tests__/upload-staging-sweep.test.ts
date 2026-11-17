import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  ListObjectsV2Command: class {
    kind = 'list';
    constructor(public input: Record<string, unknown>) {}
  },
  DeleteObjectsCommand: class {
    kind = 'delete';
    constructor(public input: Record<string, unknown>) {}
  },
}));

const mockSend = vi.fn();
vi.mock('@/lib/presigned-url', () => ({
  getS3Client: () => ({ send: mockSend }),
  getS3Bucket: () => 'test-bucket',
}));

import { sweepStaleUploadStaging } from '../upload-staging-sweep';

// The sweep's documented max age: a day.
const UPLOAD_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NOW = new Date('2026-11-17T12:00:00Z');
const old = new Date(NOW.getTime() - UPLOAD_STAGING_MAX_AGE_MS - 1000);
const fresh = new Date(NOW.getTime() - 60_000);

type Sent = { kind: string; input: Record<string, unknown> };
const sent = (): Sent[] => mockSend.mock.calls.map((c) => c[0] as Sent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sweepStaleUploadStaging', () => {
  it('deletes staging and holding objects older than the max age, and leaves fresh ones', async () => {
    mockSend.mockImplementation(async (cmd: Sent) => {
      if (cmd.kind === 'delete') return {};
      if (cmd.input.Prefix === 'uploads/staging/') {
        return { Contents: [{ Key: 'uploads/staging/old-1', LastModified: old }, { Key: 'uploads/staging/new-1', LastModified: fresh }] };
      }
      return { Contents: [{ Key: 'uploads/verifying/old-2', LastModified: old }] };
    });

    expect(await sweepStaleUploadStaging(NOW)).toBe(2);

    const deletes = sent().filter((c) => c.kind === 'delete');
    const keys = deletes.flatMap((c) => (c.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
    expect(keys.sort()).toEqual(['uploads/staging/old-1', 'uploads/verifying/old-2']);
  });

  it('only ever lists the two per-job prefixes, never the served files/ keys', async () => {
    mockSend.mockResolvedValue({ Contents: [] });

    await sweepStaleUploadStaging(NOW);

    const prefixes = sent().filter((c) => c.kind === 'list').map((c) => c.input.Prefix);
    expect(prefixes.sort()).toEqual(['uploads/staging/', 'uploads/verifying/']);
  });

  it('never deletes a key outside the per-job prefixes, even if a listing returns one', async () => {
    mockSend.mockImplementation(async (cmd: Sent) =>
      cmd.kind === 'delete' ? {} : { Contents: [{ Key: `files/${'a'.repeat(64)}/original`, LastModified: old }] });

    expect(await sweepStaleUploadStaging(NOW)).toBe(0);
    expect(sent().some((c) => c.kind === 'delete')).toBe(false);
  });

  it('reaches stale objects past many pages of fresh ones within a single run', async () => {
    const PAGES = 15;
    let staged = 0;
    mockSend.mockImplementation(async (cmd: Sent) => {
      if (cmd.kind === 'delete') return {};
      if (cmd.input.Prefix !== 'uploads/staging/') return { Contents: [] };
      const page = cmd.input.ContinuationToken ? Number(String(cmd.input.ContinuationToken).slice(1)) : 0;
      staged += 1;
      const last = page === PAGES - 1;
      return {
        Contents: [{ Key: `uploads/staging/p${page}`, LastModified: last ? old : fresh }],
        IsTruncated: !last,
        NextContinuationToken: last ? undefined : `t${page + 1}`,
      };
    });

    expect(await sweepStaleUploadStaging(NOW)).toBe(1);
    expect(staged).toBe(PAGES);
    const keys = sent().filter((c) => c.kind === 'delete')
      .flatMap((c) => (c.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
    expect(keys).toEqual([`uploads/staging/p${PAGES - 1}`]);
  });
});

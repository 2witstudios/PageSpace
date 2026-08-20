import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockS3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn((params) => ({ __type: 'get', ...params })),
  HeadObjectCommand: vi.fn((params) => ({ __type: 'head', ...params })),
  PutObjectCommand: vi.fn((params) => ({ __type: 'put', ...params })),
  DeleteObjectCommand: vi.fn((params) => ({ __type: 'delete', ...params })),
}));

const mockStat = vi.fn();
const mockUnlink = vi.fn();
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: (...args: unknown[]) => mockStat(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
  },
}));

/** Reference counts per table, keyed by the order of CONTENT_REF_SOURCES. */
const refCounts: number[] = [];
let selectCall = 0;
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ value: refCounts[selectCall++] ?? 0 }],
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  count: vi.fn(() => 'count()'),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: { contentRef: 'activityLogs.contentRef' },
}));
vi.mock('@pagespace/db/schema/versioning', () => ({
  pageVersions: { contentRef: 'pageVersions.contentRef' },
}));

import { deletePageContent, RECLAIM_MIN_AGE_MS } from '../page-content-store';

const VALID_REF = 'a'.repeat(64);
const NOW = new Date('2026-08-19T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

/** Reference counts for [page_versions, activity_logs]. */
function setReferences(versions: number, activities: number): void {
  refCounts.length = 0;
  refCounts.push(versions, activities);
  selectCall = 0;
}

function s3HasObject(lastModified: Date | null): void {
  mockS3Send.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'head') return { LastModified: lastModified ?? undefined };
    if (command.__type === 'delete') return {};
    throw new Error(`unexpected command ${command.__type}`);
  });
}

function s3Missing(): void {
  const notFound = Object.assign(new Error('NoSuchKey'), { name: 'NotFound' });
  mockS3Send.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'head') throw notFound;
    if (command.__type === 'delete') return {};
    throw new Error(`unexpected command ${command.__type}`);
  });
}

const deleteCommands = () =>
  mockS3Send.mock.calls.filter(([command]) => (command as { __type: string }).__type === 'delete');

describe('deletePageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUCKET_NAME = 'test-bucket';
    process.env.PAGE_CONTENT_STORAGE_PATH = '/data/storage';
    setReferences(0, 0);
    mockStat.mockRejectedValue(new Error('ENOENT'));
    mockUnlink.mockResolvedValue(undefined);
  });

  it('given two pages share the ref and one is deleted, keeps the blob', async () => {
    setReferences(1, 0);
    s3HasObject(OLD);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({
      deleted: false,
      remainingReferences: 1,
      reason: 'still-referenced',
    });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('counts references from activity logs too, not only page versions', async () => {
    setReferences(0, 1);
    s3HasObject(OLD);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: false, reason: 'still-referenced' });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('given the last reference is dropped, removes the object from storage', async () => {
    setReferences(0, 0);
    s3HasObject(OLD);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: true, remainingReferences: 0 });
    expect(deleteCommands()).toHaveLength(1);
    expect(deleteCommands()[0][0]).toMatchObject({
      Bucket: 'test-bucket',
      Key: `page-content/aa/${VALID_REF}`,
    });
  });

  it('never reclaims a blob written moments ago, even with zero references', async () => {
    setReferences(0, 0);
    s3HasObject(new Date(NOW.getTime() - 1000));

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: false, reason: 'too-young' });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('fails closed when the object cannot be dated', async () => {
    setReferences(0, 0);
    s3HasObject(null);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: false, reason: 'age-unknown' });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('reclaims pre-cutover content that still lives only on the filesystem', async () => {
    setReferences(0, 0);
    s3Missing();
    mockStat.mockResolvedValue({ mtime: OLD });

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: true });
    expect(mockUnlink).toHaveBeenCalledWith(`/data/storage/page-content/aa/${VALID_REF}`);
    expect(deleteCommands()).toHaveLength(0);
  });

  it('given the blob is already gone, reports it without throwing', async () => {
    setReferences(0, 0);
    s3Missing();

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: false, reason: 'not-stored' });
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('rejects a ref that could escape the content prefix', async () => {
    await expect(deletePageContent('../../../etc/passwd')).rejects.toThrow(
      'Invalid content reference'
    );
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('defaults the age floor to a day', () => {
    expect(RECLAIM_MIN_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

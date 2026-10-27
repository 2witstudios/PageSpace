import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockS3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', async () => {
  // Type the constructor params off the real SDK inputs rather than leaving
  // them inferred: a mocked request that no longer matches what the store
  // actually sends should be a type error here, not a silently passing test.
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  type Get = ConstructorParameters<typeof actual.GetObjectCommand>[0];
  type Head = ConstructorParameters<typeof actual.HeadObjectCommand>[0];
  type Put = ConstructorParameters<typeof actual.PutObjectCommand>[0];
  type Del = ConstructorParameters<typeof actual.DeleteObjectCommand>[0];
  type Copy = ConstructorParameters<typeof actual.CopyObjectCommand>[0];
  return {
    S3Client: vi.fn(() => ({ send: mockS3Send })),
    GetObjectCommand: vi.fn((params: Get) => ({ __type: 'get', ...params })),
    HeadObjectCommand: vi.fn((params: Head) => ({ __type: 'head', ...params })),
    PutObjectCommand: vi.fn((params: Put) => ({ __type: 'put', ...params })),
    DeleteObjectCommand: vi.fn((params: Del) => ({ __type: 'delete', ...params })),
    CopyObjectCommand: vi.fn((params: Copy) => ({ __type: 'copy', ...params })),
  };
});

const mockStat = vi.fn();
const mockUnlink = vi.fn();
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: (...args: unknown[]) => mockStat(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
  },
}));

/**
 * Whether the reference probe finds a row. The store derives its table list
 * from the real schema barrel (left unmocked — table definitions open no
 * connection), so this stands in for "some table still points at the blob".
 */
let referenced = false;
/**
 * `deletePageContent` runs everything inside `db.transaction`, taking the ref's
 * advisory lock on the transaction handle before it reads references. The mock
 * therefore has to hand the callback a `tx` that can do both: `execute` for the
 * lock, `select` for the reference probe. Recording the lock statements lets a
 * test assert the lock is actually taken rather than merely assumed.
 */
const { mockExecute } = vi.hoisted(() => ({
  // Typed with the statement it receives so the lock assertion below can read
  // it back without an unsound cast.
  mockExecute: vi.fn(async (_statement: { strings: TemplateStringsArray }) => undefined),
}));
vi.mock('@pagespace/db/db', () => {
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (referenced ? [{ contentRef: 'a'.repeat(64) }] : []),
      }),
    }),
  });
  const tx = { select, execute: mockExecute };
  return {
    db: {
      select,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { param: (v: unknown) => v }
  ),
}));

import { deletePageContent, RECLAIM_MIN_AGE_MS } from '../page-content-store';

const VALID_REF = 'a'.repeat(64);
const NOW = new Date('2026-08-19T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

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
    referenced = false;
    mockStat.mockRejectedValue(new Error('ENOENT'));
    mockUnlink.mockResolvedValue(undefined);
  });

  it('takes the ref lock before it reads references or storage', async () => {
    // The lock is the whole defence against the dedupe race: a writer that
    // finds this object already present skips its upload and hands the ref to a
    // caller that has not yet committed a row for it. Without serialising, the
    // reclaimer sees zero references, deletes, and that caller commits a ref
    // pointing at nothing. Removing the lock must fail here.
    referenced = false;
    s3HasObject(OLD);

    await deletePageContent(VALID_REF, { now: NOW });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [statement] = mockExecute.mock.calls[0];
    expect(statement.strings.join('')).toContain('pg_advisory_xact_lock');
  });

  it('given two pages share the ref and one is deleted, keeps the blob', async () => {
    referenced = true;
    s3HasObject(OLD);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toEqual({ ref: VALID_REF, deleted: false, reason: 'still-referenced' });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('does not go near storage for a blob it already knows is referenced', async () => {
    referenced = true;
    s3HasObject(OLD);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toEqual({ ref: VALID_REF, deleted: false, reason: 'still-referenced' });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('given the last reference is dropped, removes the object from storage', async () => {
    referenced = false;
    s3HasObject(OLD);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toEqual({ ref: VALID_REF, deleted: true });
    expect(deleteCommands()).toHaveLength(1);
    expect(deleteCommands()[0][0]).toMatchObject({
      Bucket: 'test-bucket',
      Key: `page-content/aa/${VALID_REF}`,
    });
  });

  it('never reclaims a blob written moments ago, even with zero references', async () => {
    referenced = false;
    s3HasObject(new Date(NOW.getTime() - 1000));

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: false, reason: 'too-young' });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('fails closed when the object cannot be dated', async () => {
    referenced = false;
    s3HasObject(null);

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: false, reason: 'age-unknown' });
    expect(deleteCommands()).toHaveLength(0);
  });

  it('reclaims pre-cutover content that still lives only on the filesystem', async () => {
    referenced = false;
    s3Missing();
    mockStat.mockResolvedValue({ mtime: OLD });

    const result = await deletePageContent(VALID_REF, { now: NOW });

    expect(result).toMatchObject({ deleted: true });
    expect(mockUnlink).toHaveBeenCalledWith(`/data/storage/page-content/aa/${VALID_REF}`);
    expect(deleteCommands()).toHaveLength(0);
  });

  it('given the blob is already gone, reports it without throwing', async () => {
    referenced = false;
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

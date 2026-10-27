/**
 * Unit tests for the anchor publisher shells (#890 Phase 2, leaf 3).
 *
 * Anchor SEMANTICS (payload bytes, signature) are pure and pinned in
 * @pagespace/lib anchor.test.ts — these tests exercise ONLY the shells:
 * env config parsing, the S3 PutObject wiring (Object-Lock params gated by
 * the capability flag), and the receipt INSERT. Publishers propagate their
 * errors to the caller — swallowing/loud-logging is the chainer hook's job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { buildAnchorPayload, serializeSignedAnchor } from '@pagespace/lib/audit/anchor';

import {
  loadAnchorConfig,
  validateAnchorConfig,
  buildAnchorObjectKey,
  computeRetainUntilDate,
  createS3AnchorPublisher,
  createAnchorReceiptPublisher,
} from '../anchor-publishers';

const anchor = buildAnchorPayload({
  head: 'a'.repeat(64),
  chainSeq: 42,
  anchoredAt: new Date('2026-02-01T00:00:00.000Z'),
  secret: 'test-secret',
});

describe('loadAnchorConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const key of [
      'AUDIT_ANCHOR_ENABLED',
      'AUDIT_ANCHOR_SECRET',
      'AUDIT_ANCHOR_EVERY_RUNS',
      'AUDIT_ANCHOR_MIN_INTERVAL_S',
      'ANCHOR_S3_BUCKET',
      'ANCHOR_S3_RETENTION_DAYS',
      'ANCHOR_S3_OBJECT_LOCK',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  it('given no env at all, should be disabled (anchoring is OFF unless configured)', () => {
    const config = loadAnchorConfig();

    expect(config.enabled).toBe(false);
  });

  it('given AUDIT_ANCHOR_ENABLED=true with a secret, should enable with defaults everyRuns=1, minIntervalS=0, no S3', () => {
    vi.stubEnv('AUDIT_ANCHOR_ENABLED', 'true');
    vi.stubEnv('AUDIT_ANCHOR_SECRET', 'hmac-secret');

    const config = loadAnchorConfig();

    expect(config).toEqual({
      enabled: true,
      secret: 'hmac-secret',
      everyRuns: 1,
      minIntervalS: 0,
      s3: undefined,
    });
  });

  it('given the full env matrix, should parse every field including the S3 capability flag', () => {
    vi.stubEnv('AUDIT_ANCHOR_ENABLED', 'true');
    vi.stubEnv('AUDIT_ANCHOR_SECRET', 'hmac-secret');
    vi.stubEnv('AUDIT_ANCHOR_EVERY_RUNS', '5');
    vi.stubEnv('AUDIT_ANCHOR_MIN_INTERVAL_S', '600');
    vi.stubEnv('ANCHOR_S3_BUCKET', 'audit-anchors');
    vi.stubEnv('ANCHOR_S3_RETENTION_DAYS', '30');
    vi.stubEnv('ANCHOR_S3_OBJECT_LOCK', 'true');

    const config = loadAnchorConfig();

    expect(config).toEqual({
      enabled: true,
      secret: 'hmac-secret',
      everyRuns: 5,
      minIntervalS: 600,
      s3: { bucket: 'audit-anchors', retentionDays: 30, objectLock: true },
    });
  });

  it('given garbage numerics, should fall back to defaults (everyRuns 1, minIntervalS 0, retentionDays 365)', () => {
    vi.stubEnv('AUDIT_ANCHOR_ENABLED', 'true');
    vi.stubEnv('AUDIT_ANCHOR_SECRET', 's');
    vi.stubEnv('AUDIT_ANCHOR_EVERY_RUNS', 'lots');
    vi.stubEnv('AUDIT_ANCHOR_MIN_INTERVAL_S', '-3');
    vi.stubEnv('ANCHOR_S3_BUCKET', 'b');
    vi.stubEnv('ANCHOR_S3_RETENTION_DAYS', 'forever');

    const config = loadAnchorConfig();

    expect(config.everyRuns).toBe(1);
    expect(config.minIntervalS).toBe(0);
    expect(config.s3).toEqual({ bucket: 'b', retentionDays: 365, objectLock: false });
  });
});

describe('validateAnchorConfig', () => {
  it('given a disabled config, should be valid (off is always a legal state)', () => {
    expect(validateAnchorConfig({ enabled: false, secret: '', everyRuns: 1, minIntervalS: 0, s3: undefined }))
      .toEqual({ valid: true, errors: [] });
  });

  it('given enabled without a secret, should name AUDIT_ANCHOR_SECRET', () => {
    const result = validateAnchorConfig({ enabled: true, secret: '', everyRuns: 1, minIntervalS: 0, s3: undefined });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('AUDIT_ANCHOR_SECRET');
  });
});

describe('buildAnchorObjectKey', () => {
  it('given an anchor, should lay out anchors/<chain_seq>-<epoch-ms>.json', () => {
    expect(buildAnchorObjectKey(anchor)).toBe(
      `anchors/42-${new Date('2026-02-01T00:00:00.000Z').getTime()}.json`,
    );
  });
});

describe('computeRetainUntilDate', () => {
  it('given retentionDays, should add exactly that many days to the anchor time', () => {
    const retainUntil = computeRetainUntilDate(new Date('2026-02-01T00:00:00.000Z'), 30);

    expect(retainUntil.toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });
});

describe('createS3AnchorPublisher', () => {
  it('given Object-Lock capability ON, should PutObject the serialized anchor with COMPLIANCE retention', async () => {
    const send = vi.fn().mockResolvedValue({});
    const publisher = createS3AnchorPublisher({
      s3Client: { send },
      bucket: 'audit-anchors',
      retentionDays: 30,
      objectLock: true,
    });

    await publisher.publish(anchor);

    expect(publisher.name).toBe('s3');
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'audit-anchors',
      Key: buildAnchorObjectKey(anchor),
      Body: serializeSignedAnchor(anchor),
      ContentType: 'application/json',
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: computeRetainUntilDate(new Date(anchor.anchoredAt), 30),
    });
  });

  it('given Object-Lock capability OFF (provider may not support it), should PutObject WITHOUT lock params', async () => {
    const send = vi.fn().mockResolvedValue({});
    const publisher = createS3AnchorPublisher({
      s3Client: { send },
      bucket: 'audit-anchors',
      retentionDays: 30,
      objectLock: false,
    });

    await publisher.publish(anchor);

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command.input).toEqual({
      Bucket: 'audit-anchors',
      Key: buildAnchorObjectKey(anchor),
      Body: serializeSignedAnchor(anchor),
      ContentType: 'application/json',
    });
  });

  it('given the S3 client rejects, should propagate the error (the chainer hook owns swallowing)', async () => {
    const publisher = createS3AnchorPublisher({
      s3Client: { send: vi.fn().mockRejectedValue(new Error('bucket gone')) },
      bucket: 'b',
      retentionDays: 1,
      objectLock: false,
    });

    await expect(publisher.publish(anchor)).rejects.toThrow('bucket gone');
  });
});

describe('createAnchorReceiptPublisher', () => {
  const makePool = (query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })) => {
    const release = vi.fn();
    const client = { query, release };
    return { pool: { connect: vi.fn().mockResolvedValue(client) }, query, release };
  };

  it('given an anchor, should INSERT one receipt row with the signed fields (no RETURNING — the role has no SELECT)', async () => {
    const { pool, query, release } = makePool();
    const publisher = createAnchorReceiptPublisher({ pool });

    await publisher.publish(anchor);

    expect(publisher.name).toBe('receipt');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO security_audit_anchors');
    expect(sql).not.toContain('RETURNING');
    expect(sql).toContain('version');
    expect(sql).toContain('chain_seq');
    expect(sql).toContain('head_hash');
    expect(sql).toContain('anchored_at');
    expect(sql).toContain('signature');
    // id (cuid2, publisher-minted) + the five signed fields.
    expect(params).toHaveLength(6);
    expect(params.slice(1)).toEqual([
      anchor.version,
      anchor.chainSeq,
      anchor.head,
      new Date(anchor.anchoredAt),
      anchor.signature,
    ]);
    expect(typeof params[0]).toBe('string');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('given the INSERT rejects, should propagate the error AND still release the client', async () => {
    const { pool, release } = makePool(vi.fn().mockRejectedValue(new Error('42501')));
    const publisher = createAnchorReceiptPublisher({ pool });

    await expect(publisher.publish(anchor)).rejects.toThrow('42501');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

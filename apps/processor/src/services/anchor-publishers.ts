/**
 * Anchor publisher shells (#890 Phase 2, leaf 3).
 *
 * The chainer's externally-witnessed head: after an anchor interval, the
 * signed head statement (pure core: @pagespace/lib/audit/anchor) is published
 * to surfaces the Admin PG credentials cannot rewrite:
 *
 *   - S3 Object-Lock WORM (`anchors/<chain_seq>-<ts>.json`) — the true
 *     external witness. Object-Lock params are gated by ANCHOR_S3_OBJECT_LOCK
 *     because the current provider (Tigris) may not support them; bucket
 *     provisioning and lock-mode verification belong to the Phase 6 runbook.
 *   - security_audit_anchors receipt rows (writeReceipts precedent) — the
 *     second, already-shipped witness surface; append-only for every role.
 *
 * Everything here is a thin factory shell with explicit deps — no logic
 * beyond wiring. Publishers PROPAGATE errors; the chainer hook owns
 *  fire-and-forget semantics (publish failure never blocks chaining).
 *
 * Env matrix (anchoring is OFF unless configured — AUDIT_SIEM_ENABLED
 * precedent):
 *   AUDIT_ANCHOR_ENABLED        'true' to enable
 *   AUDIT_ANCHOR_SECRET         HMAC-SHA256 signing key (required if enabled)
 *   AUDIT_ANCHOR_EVERY_RUNS     publish every Nth 'chained' run (default 1)
 *   AUDIT_ANCHOR_MIN_INTERVAL_S minimum seconds between anchors (default 0)
 *   ANCHOR_S3_BUCKET            enables the S3 publisher when set
 *   ANCHOR_S3_RETENTION_DAYS    Object-Lock retention (default 365)
 *   ANCHOR_S3_OBJECT_LOCK       'true' to send Object-Lock params
 */

import { createId } from '@paralleldrive/cuid2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { serializeSignedAnchor, type SignedAnchor } from '@pagespace/lib/audit/anchor';

/** A witness surface the chainer hook publishes each signed anchor to. */
export interface AnchorPublisher {
  name: string;
  publish(anchor: SignedAnchor): Promise<void>;
}

export interface AnchorS3Config {
  bucket: string;
  retentionDays: number;
  /** Capability flag: send Object-Lock params (provider must support them). */
  objectLock: boolean;
}

export interface AnchorConfig {
  enabled: boolean;
  secret: string;
  everyRuns: number;
  minIntervalS: number;
  s3: AnchorS3Config | undefined;
}

function positiveIntOr(fallback: number, raw: string | undefined, minimum = 1): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Load anchoring configuration from environment variables. */
export function loadAnchorConfig(): AnchorConfig {
  const bucket = process.env.ANCHOR_S3_BUCKET || '';

  return {
    enabled: process.env.AUDIT_ANCHOR_ENABLED === 'true',
    secret: process.env.AUDIT_ANCHOR_SECRET || '',
    everyRuns: positiveIntOr(1, process.env.AUDIT_ANCHOR_EVERY_RUNS),
    minIntervalS: positiveIntOr(0, process.env.AUDIT_ANCHOR_MIN_INTERVAL_S, 0),
    s3: bucket
      ? {
          bucket,
          retentionDays: positiveIntOr(365, process.env.ANCHOR_S3_RETENTION_DAYS),
          objectLock: process.env.ANCHOR_S3_OBJECT_LOCK === 'true',
        }
      : undefined,
  };
}

/** Validate anchoring configuration (loadSiemConfig/validateSiemConfig precedent). */
export function validateAnchorConfig(config: AnchorConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.secret) {
    errors.push('AUDIT_ANCHOR_SECRET is required when AUDIT_ANCHOR_ENABLED=true');
  }

  return { valid: errors.length === 0, errors };
}

/** WORM key layout: anchors/<chain_seq>-<epoch-ms>.json (sortable, collision-free per run). */
export function buildAnchorObjectKey(anchor: SignedAnchor): string {
  return `anchors/${anchor.chainSeq}-${new Date(anchor.anchoredAt).getTime()}.json`;
}

/** Object-Lock retention horizon: anchoredAt + retentionDays. */
export function computeRetainUntilDate(anchoredAt: Date, retentionDays: number): Date {
  return new Date(anchoredAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

// Minimal structural S3 surface so tests inject a plain double and the
// factory stays decoupled from the concrete client (createS3Client wiring
// happens at the chainer hook).
export interface S3ClientLike {
  send(command: PutObjectCommand): Promise<unknown>;
}

export interface CreateS3AnchorPublisherDeps extends AnchorS3Config {
  s3Client: S3ClientLike;
}

/**
 * S3 Object-Lock publisher — one PutObject per anchor, body = the canonical
 * serialized anchor (byte-comparable against a recomputation on fetch).
 */
export function createS3AnchorPublisher(deps: CreateS3AnchorPublisherDeps): AnchorPublisher {
  return {
    name: 's3',
    async publish(anchor: SignedAnchor): Promise<void> {
      await deps.s3Client.send(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: buildAnchorObjectKey(anchor),
          Body: serializeSignedAnchor(anchor),
          ContentType: 'application/json',
          ...(deps.objectLock
            ? {
                ObjectLockMode: 'COMPLIANCE',
                ObjectLockRetainUntilDate: computeRetainUntilDate(
                  new Date(anchor.anchoredAt),
                  deps.retentionDays,
                ),
              }
            : {}),
        }),
      );
    },
  };
}

// Minimal pg surface (this workspace ships no @types/pg — see ../db.ts).
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClient>;
}

/**
 * Receipt publisher — one INSERT into security_audit_anchors per anchor, as
 * the chainer's own identity (admin_chainer holds INSERT and nothing else on
 * this table, so no RETURNING). The cuid2 id is minted here because raw SQL
 * bypasses Drizzle's $defaultFn (writeReceipts precedent).
 */
export function createAnchorReceiptPublisher(deps: { pool: PgPoolLike }): AnchorPublisher {
  return {
    name: 'receipt',
    async publish(anchor: SignedAnchor): Promise<void> {
      const client = await deps.pool.connect();
      try {
        await client.query(
          `INSERT INTO security_audit_anchors
             (id, version, chain_seq, head_hash, anchored_at, signature)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            createId(),
            anchor.version,
            anchor.chainSeq,
            anchor.head,
            new Date(anchor.anchoredAt),
            anchor.signature,
          ],
        );
      } finally {
        client.release();
      }
    },
  };
}

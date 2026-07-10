/**
 * Audit chainer worker — the single writer of the security_audit_log chain
 * (#890 Phase 2, leaf 2).
 *
 * Drains the Admin PG ingest queue (security_audit_ingest, filled by the
 * lock-free emission path) in (emitted_at, id) order, assigns chain linkage
 * via the pure core (@pagespace/lib/audit/chain-step — chainHash =
 * H(emissionHash, prevHash)), appends the chained rows and deletes the
 * drained queue rows in ONE transaction, then re-reads what it wrote and
 * verifies it (verify-on-append). Exactly one process links hashes:
 * serialization is by construction (run-level advisory lock on the ADMIN
 * pool), not by contention — this replaces the per-request global
 * pg_advisory_xact_lock.
 *
 * Identity: connects through ADMIN_DATABASE_URL, which for the processor is
 * admin_processor_user (admin_chainer + admin_siem templates) — SELECT+DELETE
 * on the ingest queue (the only DELETE in the trust plane), SELECT+INSERT on
 * security_audit_log, and USAGE on the chain_seq sequence. Nothing more.
 *
 * Scheduled by pg-boss every 30s with retryLimit 0 (siem-delivery pattern):
 * overlapping runs don't stack, and the advisory lock serializes any that
 * still overlap. When ADMIN_DATABASE_URL is unset the worker no-ops — the
 * production write path stays on the advisory-lock repository until leaf 5
 * cuts emission over, so the queue is simply empty until then.
 *
 * ERA-FORK GUARD: chaining from a 'genesis' head is refused unless
 * AUDIT_CHAINER_ALLOW_GENESIS=true — set ONLY on fresh installs. On upgrades
 * the head is empty until the legacy backfill runs, and chaining new events
 * from genesis there would fork the eras irrecoverably (see UPGRADE.md
 * Phase 2); the ingest queue buffers losslessly until the backfill plants
 * the legacy head.
 *
 * ANCHORING (leaf 3): after a 'chained' run whose verify-on-append is green,
 * the fresh head (newHead + its chain_seq) is signed (pure core:
 * @pagespace/lib/audit/anchor) and published to the configured witness
 * surfaces (S3 Object-Lock + the security_audit_anchors receipt table) per
 * the interval policy (AUDIT_ANCHOR_EVERY_RUNS / AUDIT_ANCHOR_MIN_INTERVAL_S).
 * Publish failure NEVER blocks or corrupts chaining — loud logging plus an
 * alert on a repeated-failure streak.
 */

import {
  assignChainBatch,
  verifyAppendedSegment,
  GENESIS_PREVIOUS_HASH,
  type ChainableIngestRow,
  type ChainedRowPayload,
  type AppendedChainRow,
  type SegmentVerificationResult,
} from '@pagespace/lib/audit/chain-step';
import { buildAnchorPayload } from '@pagespace/lib/audit/anchor';
import {
  notifyChainAppendVerificationFailure,
  notifyAnchorPublishFailure,
} from '@pagespace/lib/audit/security-audit-alerting';
import {
  loadAnchorConfig,
  validateAnchorConfig,
  createS3AnchorPublisher,
  createAnchorReceiptPublisher,
  type AnchorConfig,
  type AnchorPublisher,
} from '../services/anchor-publishers';
import { createS3Client } from '../s3-client';
import { getAdminPoolForWorker } from '../db';

const ADVISORY_LOCK_KEY = 'audit-chainer';
const DEFAULT_BATCH_SIZE = 500;

// Alert every time a publisher's consecutive-failure streak reaches a
// multiple of this — a chain appending unwitnessed for long is exactly the
// window a tamper needs.
const ANCHOR_FAILURE_ALERT_STREAK = 3;

// Column list for the drain SELECT — aliased to the camelCase shape the pure
// core consumes (ChainableIngestRow). emitted_at is drain ordering only and
// deliberately not selected: it is not chained content.
const INGEST_COLUMNS = `id,
        event_type AS "eventType",
        user_id AS "userId",
        session_id AS "sessionId",
        service_id AS "serviceId",
        resource_type AS "resourceType",
        resource_id AS "resourceId",
        ip_address AS "ipAddress",
        ip_bidx AS "ipBidx",
        user_agent AS "userAgent",
        geo_location AS "geoLocation",
        details,
        risk_score AS "riskScore",
        anomaly_flags AS "anomalyFlags",
        timestamp,
        emission_hash AS "emissionHash"`;

// Minimal subset of pg's PoolClient API this worker uses — defined locally
// because the processor build is self-contained (see ../db).
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  /** pg semantics: release(err) DESTROYS the connection instead of pooling it. */
  release(destroyWithError?: Error): void;
}

interface PgPool {
  connect(): Promise<PgClient>;
}

export interface AuditChainerOverrides {
  /** Injected pool (integration tests connect AS a specific login user). */
  pool?: PgPool;
  /** Drain batch size (default AUDIT_CHAINER_BATCH_SIZE env or 500). */
  batchSize?: number;
  /** Injected anchor config (default: loadAnchorConfig() from env). */
  anchorConfig?: AnchorConfig;
  /** Injected witness publishers (default: receipt + S3 when configured). */
  anchorPublishers?: AnchorPublisher[];
}

/** What the anchoring hook did after a chained run (absent when anchoring is off). */
export interface AnchorPublishSummary {
  attempted: boolean;
  skippedReason?: 'invalid_config' | 'missing_head_seq' | 'every_runs' | 'min_interval';
  chainSeq?: number;
  published?: string[];
  failed?: string[];
}

export interface AuditChainerRunResult {
  outcome: 'disabled' | 'lock_busy' | 'idle' | 'genesis_refused' | 'chained';
  drained: number;
  verification?: SegmentVerificationResult;
  /** event_hash of the last appended row — the anchored head. */
  newHead?: string;
  /** chain_seq of the last appended row (as stored by the table sequence). */
  newHeadSeq?: number;
  anchor?: AnchorPublishSummary;
}

// Anchor scheduling is process-level state: the interval policy spans runs,
// and the single-writer lock means at most one live chainer per Admin PG —
// module scope IS the right home for it.
interface AnchorScheduleState {
  runsSinceAnchor: number;
  lastAnchorAtMs: number | null;
  failureStreaks: Map<string, number>;
}

const anchorState: AnchorScheduleState = {
  runsSinceAnchor: 0,
  lastAnchorAtMs: null,
  failureStreaks: new Map(),
};

export function resetAnchorPublishStateForTests(): void {
  anchorState.runsSinceAnchor = 0;
  anchorState.lastAnchorAtMs = null;
  anchorState.failureStreaks.clear();
}

function resolveBatchSize(override: number | undefined): number {
  if (override !== undefined) return override;
  const fromEnv = Number.parseInt(process.env.AUDIT_CHAINER_BATCH_SIZE ?? '', 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_BATCH_SIZE;
}

/**
 * Read the current chain head: event_hash of the highest chain_seq row, or
 * the genesis sentinel on an empty chain. This is the single head-read hook —
 * the anchoring leaf publishes exactly this value, and the backfill leaf's
 * legacy-head anchor becomes the head this returns once backfill has run
 * (the first post-cutover batch then links to it with no special casing).
 */
async function readChainHead(client: PgClient): Promise<string> {
  const result = await client.query(
    'SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1',
  );
  return (result.rows[0] as { event_hash: string } | undefined)?.event_hash ?? GENESIS_PREVIOUS_HASH;
}

/** Default witness surfaces: the receipt table always; S3 when configured. */
function buildDefaultAnchorPublishers(config: AnchorConfig, pool: PgPool): AnchorPublisher[] {
  const publishers: AnchorPublisher[] = [createAnchorReceiptPublisher({ pool })];
  if (config.s3) {
    publishers.push(createS3AnchorPublisher({ s3Client: createS3Client(), ...config.s3 }));
  }
  return publishers;
}

/**
 * Anchor the verified head per the interval policy. Fire-and-forget contract:
 * this function NEVER throws — a witness surface being down must not block
 * chaining (the queue drain already committed). Failures log loudly and, on a
 * repeated streak, escalate through the chain-alert surface.
 */
async function maybePublishAnchor(
  head: string,
  chainSeq: number | undefined,
  pool: PgPool,
  overrides: AuditChainerOverrides,
): Promise<AnchorPublishSummary | undefined> {
  const config = overrides.anchorConfig ?? loadAnchorConfig();
  if (!config.enabled) {
    return undefined;
  }

  const validation = validateAnchorConfig(config);
  if (!validation.valid) {
    console.error(
      `[audit-chainer] Anchoring skipped — invalid config: ${validation.errors.join('; ')}`,
    );
    return { attempted: false, skippedReason: 'invalid_config' };
  }

  if (chainSeq === undefined || !Number.isFinite(chainSeq)) {
    console.error('[audit-chainer] Anchoring skipped — appended head chain_seq unavailable');
    return { attempted: false, skippedReason: 'missing_head_seq' };
  }

  anchorState.runsSinceAnchor += 1;
  if (anchorState.runsSinceAnchor < config.everyRuns) {
    return { attempted: false, skippedReason: 'every_runs' };
  }
  const nowMs = Date.now();
  if (
    config.minIntervalS > 0 &&
    anchorState.lastAnchorAtMs !== null &&
    nowMs - anchorState.lastAnchorAtMs < config.minIntervalS * 1000
  ) {
    return { attempted: false, skippedReason: 'min_interval' };
  }

  const publishers = overrides.anchorPublishers ?? buildDefaultAnchorPublishers(config, pool);
  const anchor = buildAnchorPayload({
    head,
    chainSeq,
    anchoredAt: new Date(nowMs),
    secret: config.secret,
  });

  const published: string[] = [];
  const failed: string[] = [];
  for (const publisher of publishers) {
    try {
      await publisher.publish(anchor);
      published.push(publisher.name);
      anchorState.failureStreaks.delete(publisher.name);
    } catch (error) {
      failed.push(publisher.name);
      const streak = (anchorState.failureStreaks.get(publisher.name) ?? 0) + 1;
      anchorState.failureStreaks.set(publisher.name, streak);
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[audit-chainer] ANCHOR PUBLISH FAILED publisher=${publisher.name} chainSeq=${chainSeq} head=${head} streak=${streak}: ${message}`,
      );
      if (streak % ANCHOR_FAILURE_ALERT_STREAK === 0) {
        try {
          await notifyAnchorPublishFailure({
            publisherName: publisher.name,
            consecutiveFailures: streak,
            chainSeq,
            head,
            errorMessage: message,
          });
        } catch (alertError) {
          const alertMessage = alertError instanceof Error ? alertError.message : String(alertError);
          console.warn(`[audit-chainer] Anchor failure alert failed: ${alertMessage}`);
        }
      }
    }
  }

  if (published.length > 0) {
    // Only a witnessed head resets the schedule: on total failure the next
    // chained run retries immediately instead of waiting out the interval.
    anchorState.runsSinceAnchor = 0;
    anchorState.lastAnchorAtMs = nowMs;
    console.log(
      `[audit-chainer] Anchored head chain_seq=${chainSeq} (${head.slice(0, 12)}…) to ${published.join('+')}`,
    );
  }

  return { attempted: true, chainSeq, published, failed };
}

/** Build the multi-row parameterized INSERT for a chained batch, in payload order. */
function buildChainedInsert(payloads: ChainedRowPayload[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const rows = payloads.map((p) => {
    const base = values.length;
    values.push(
      p.id,
      p.eventType,
      p.userId,
      p.sessionId,
      p.serviceId,
      p.resourceType,
      p.resourceId,
      p.ipAddress,
      p.ipBidx,
      p.userAgent,
      p.geoLocation,
      p.details === null ? null : JSON.stringify(p.details),
      p.riskScore,
      p.anomalyFlags,
      p.timestamp,
      p.emissionHash,
      p.previousHash,
      p.eventHash,
    );
    const placeholders = Array.from({ length: 18 }, (_, i) => `$${base + i + 1}`);
    placeholders[11] = `${placeholders[11]}::jsonb`;
    return `(${placeholders.join(', ')})`;
  });

  // chain_seq is deliberately absent: the table default (nextval on the
  // chain sequence) assigns it per row IN VALUES ORDER, under this worker's
  // single-writer lock — so chain_seq order always matches linkage order.
  const text = `INSERT INTO security_audit_log
      (id, event_type, user_id, session_id, service_id, resource_type, resource_id,
       ip_address, ip_bidx, user_agent, geo_location, details, risk_score,
       anomaly_flags, timestamp, emission_hash, previous_hash, event_hash)
     VALUES ${rows.join(', ')}`;

  return { text, values };
}

/**
 * One chainer run: try-lock → drain a batch → chain (pure) → commit → verify.
 * Returns a result summary; a run that cannot acquire the advisory lock is a
 * clean no-op (another instance is the writer for this cycle).
 */
export async function processAuditChainer(
  overrides: AuditChainerOverrides = {},
): Promise<AuditChainerRunResult> {
  if (!overrides.pool && !process.env.ADMIN_DATABASE_URL) {
    // Trust plane not configured — nothing to drain (emission cutover is
    // leaf 5; until then this is the expected state in unwired deploys).
    return { outcome: 'disabled', drained: 0 };
  }

  const pool = overrides.pool ?? getAdminPoolForWorker();
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [ADVISORY_LOCK_KEY],
    );
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);
    if (!lockAcquired) {
      return { outcome: 'lock_busy', drained: 0 };
    }

    const batchSize = resolveBatchSize(overrides.batchSize);
    const ingest = await client.query(
      `SELECT ${INGEST_COLUMNS}
       FROM security_audit_ingest
       ORDER BY emitted_at, id
       LIMIT $1`,
      [batchSize],
    );
    if (ingest.rows.length === 0) {
      // Idle poll — no log line (same rationale as siem-delivery: the vast
      // majority of 30s cycles are idle).
      return { outcome: 'idle', drained: 0 };
    }

    const ingestRows = ingest.rows as unknown as ChainableIngestRow[];
    const priorHead = await readChainHead(client);

    // Era-fork guard (#890 Phase 2 FIX): an empty admin head means either a
    // fresh install (nothing to backfill — chaining from genesis is correct)
    // or an UPGRADE whose backfill has not run yet — chaining from genesis
    // there forks the eras irrecoverably (chain columns are append-only;
    // remediation is owner-level surgery, worse once anchors are published).
    // Only the operator can tell the two apart, so a genesis link requires
    // the explicit fresh-install flag; the ingest queue is a lossless buffer
    // and simply holds the rows until the backfill plants the legacy head.
    if (priorHead === GENESIS_PREVIOUS_HASH && process.env.AUDIT_CHAINER_ALLOW_GENESIS !== 'true') {
      console.error(
        `[audit-chainer] REFUSING to chain ${ingestRows.length} ingest row(s) from a GENESIS head: ` +
          'the admin chain is empty. On a fresh install set AUDIT_CHAINER_ALLOW_GENESIS=true; on an ' +
          'upgrade run the legacy backfill (scripts/backfill-audit-db.ts) first — the head becomes ' +
          'non-genesis and chaining resumes on its own. Chaining now would fork the legacy and ' +
          'emission eras irrecoverably. Ingest rows are buffered, not lost.',
      );
      return { outcome: 'genesis_refused', drained: 0 };
    }

    const { chainedRowPayloads, newHead } = assignChainBatch(ingestRows, { prevHash: priorHead });
    const drainedIds = chainedRowPayloads.map((p) => p.id);

    // Append + drain atomically: if either side fails, the queue keeps the
    // rows and the next run re-drains them — no event can be lost between
    // the queue and the chain, and no partial state can double-chain.
    await client.query('BEGIN');
    try {
      const insert = buildChainedInsert(chainedRowPayloads);
      await client.query(insert.text, insert.values);
      await client.query('DELETE FROM security_audit_ingest WHERE id = ANY($1::text[])', [
        drainedIds,
      ]);
      await client.query('COMMIT');
    } catch (txnError) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw txnError;
    }

    // Verify-on-append: re-read the segment AS STORED (not the in-memory
    // payloads) and recompute every link from the persisted emission hashes.
    // chain_seq rides along so the anchor signs the head's stored seq.
    const appended = await client.query(
      `SELECT id,
              emission_hash AS "emissionHash",
              previous_hash AS "previousHash",
              event_hash AS "eventHash",
              chain_seq AS "chainSeq"
       FROM security_audit_log
       WHERE id = ANY($1::text[])
       ORDER BY chain_seq ASC`,
      [drainedIds],
    );
    const verification = verifyAppendedSegment(
      appended.rows as unknown as AppendedChainRow[],
      { prevHash: priorHead },
    );

    if (!verification.valid) {
      // Loud path: structured stderr for operators + the chain-verification
      // alert surface (#544). The alert helper swallows handler errors
      // internally, but wrap defensively — a broken alert surface must never
      // mask the detection or skip the lock release in the finally.
      console.error(
        `[audit-chainer] VERIFY-ON-APPEND FAILED index=${verification.breakAtIndex} entry=${verification.entryId} reason=${verification.reason} expected=${verification.expectedHash} actual=${verification.actualHash} priorHead=${priorHead}`,
      );
      try {
        await notifyChainAppendVerificationFailure({
          entryId: verification.entryId,
          breakAtIndex: verification.breakAtIndex,
          breakReason: verification.reason,
          expectedHash: verification.expectedHash,
          actualHash: verification.actualHash,
          segmentTotalRows: chainedRowPayloads.length,
          priorHead,
        });
      } catch (alertError) {
        const msg = alertError instanceof Error ? alertError.message : String(alertError);
        console.warn(`[audit-chainer] Append verification alert failed: ${msg}`);
      }
    } else {
      console.log(
        `[audit-chainer] Chained ${chainedRowPayloads.length} events (verify-on-append ok, head ${newHead.prevHash.slice(0, 12)}…)`,
      );
    }

    // The head's stored chain_seq — pg returns bigint as string.
    const lastAppended = appended.rows[appended.rows.length - 1] as
      | { chainSeq?: string | number }
      | undefined;
    const newHeadSeq =
      lastAppended?.chainSeq === undefined ? undefined : Number(lastAppended.chainSeq);

    // Anchor only a head that just verified — a witness signature on a
    // segment that failed verify-on-append would attest tampered data.
    const anchor = verification.valid
      ? await maybePublishAnchor(newHead.prevHash, newHeadSeq, pool, overrides)
      : undefined;

    return {
      outcome: 'chained',
      drained: chainedRowPayloads.length,
      verification,
      newHead: newHead.prevHash,
      ...(newHeadSeq === undefined ? {} : { newHeadSeq }),
      ...(anchor === undefined ? {} : { anchor }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[audit-chainer] Worker error:', message);
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY]);
        client.release();
      } catch (unlockError) {
        // A session that failed to unlock may still hold the session-level
        // advisory lock; returned to the pool alive it would leak the lock
        // permanently (every future run lock_busy). Destroy it instead —
        // Postgres releases session advisory locks when the backend dies.
        const err =
          unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        console.error(
          `[audit-chainer] Advisory unlock failed — destroying the connection so the session lock cannot leak into the pool: ${err.message}`,
        );
        client.release(err);
      }
    } else {
      client.release();
    }
  }
}

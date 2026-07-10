#!/usr/bin/env bun
/**
 * Backfill Script: migrate legacy security_audit_log history into the Admin PG
 * trust plane, prove the dual-era chain end to end, then write-freeze the
 * legacy table (#890 Phase 2, leaf 8 — the cutover capstone).
 *
 * POST-CUTOVER STATE THIS RESOLVES: new audit events chain in the Admin PG
 * (ingest → single-writer chainer); every pre-cutover event still sits in the
 * MAIN db's security_audit_log, invisible to the default readers and SIEM.
 * This script copies each legacy row admin-ward byte-for-byte — id, chain_seq,
 * previous_hash, event_hash, timestamp, encrypted PII columns preserved;
 * emission_hash left NULL as the legacy-era marker — so the admin store holds
 * ONE chain from genesis through the era boundary to the live head.
 *
 * ERA-BOUNDARY SEQUENCING (the crux): the chainer links its FIRST batch onto
 * whatever readChainHead() returns. Run the backfill BEFORE the chainer's
 * first run and that head is the legacy head — the eras link with zero
 * special-casing. Run the chainer first and it chains from 'genesis'; the two
 * eras can then NEVER be joined, because re-linking would rewrite chain
 * columns and no role (deliberately, including this script's owner identity
 * acting through the append-only design) holds a supported UPDATE path on
 * them. Enforcement here is threefold:
 *   1. the runbook (infrastructure/UPGRADE.md) orders: processor STOPPED →
 *      backfill → processor started. Web stays up throughout — events buffer
 *      losslessly in security_audit_ingest, which only the chainer drains;
 *   2. the script takes the chainer's own advisory lock
 *      (hashtext('audit-chainer')) on the admin pool for the whole run, so a
 *      forgotten-running chainer is provably excluded while rows are planted
 *      and the sequence is aligned;
 *   3. preconditions ABORT if an emission era already grew from 'genesis'
 *      (see UNLINKED-ERA REMEDIATION below) or if the boundary no longer
 *      matches the main head.
 *
 * SIEM VISIBILITY INVARIANT (leaf 7): the delivery worker defers the security
 * source ('awaiting_backfill') until the row its seeded cursor points at (the
 * ANCHOR row) is visible in the admin store — and from that moment every
 * legacy row must already be visible, or rows would land behind the cursor
 * and never deliver. The script therefore plants the anchor row LAST, in its
 * own transaction, after every other row and the sequence alignment have
 * committed.
 *
 * SEQUENCE ALIGNMENT: legacy rows are planted with their original chain_seq;
 * security_audit_log_chain_seq_seq is then setval'd to the max planted seq
 * (never lowered) BEFORE the advisory lock is released, so the chainer's next
 * batch continues numbering after the legacy range instead of colliding with
 * it (chain_seq has no unique constraint — collisions must be prevented, not
 * caught).
 *
 * UNLINKED-ERA REMEDIATION (manual, owner-level — the script only refuses):
 * if the chainer DID run first, the admin store holds an emission-era chain
 * from 'genesis'. While the SIEM cursor is still deferring (it always is for
 * a real seeded cursor — that is the deferral's purpose), nothing external
 * has consumed that chain, so the owner may move those rows back to the
 * queue and let the chainer re-chain them after backfill:
 *   INSERT INTO security_audit_ingest (id, event_type, user_id, session_id,
 *     service_id, resource_type, resource_id, ip_address, ip_bidx, user_agent,
 *     geo_location, details, risk_score, anomaly_flags, timestamp,
 *     emission_hash, emitted_at)
 *   SELECT id, event_type, user_id, session_id, service_id, resource_type,
 *     resource_id, ip_address, ip_bidx, user_agent, geo_location, details,
 *     risk_score, anomaly_flags, timestamp, emission_hash, now()
 *   FROM security_audit_log WHERE emission_hash IS NOT NULL;
 *   DELETE FROM security_audit_log WHERE emission_hash IS NOT NULL; -- owner only
 * DO NOT do this if anchoring was already enabled (AUDIT_ANCHOR_ENABLED):
 * published anchors (receipt table AND S3 Object-Lock) are append-only
 * witnesses of the genesis-era heads and would report tamper forever after.
 * In that case escalate — do not improvise.
 *
 * FREEZE (--freeze, separate invocation AFTER verification + SIEM release):
 * re-verifies parity + the full admin chain, then revokes INSERT/DELETE/
 * TRUNCATE on the main table and installs guard triggers that raise on any
 * write EXCEPT UPDATEs confined to the 6 eraser-scope PII columns — the main
 * erasure leg (GDPR Art 17 is time-bound) must keep working until the table
 * is dropped post-soak. The triggers bind the OWNER too (a plain REVOKE
 * cannot: production connects as the table owner, which REVOKE does not
 * restrict). Consequence, accepted by design: once frozen, BREAK-GLASS CAN NO
 * LONGER APPEND to the legacy table — break-glass is an emergency-degraded
 * mode; after the freeze its audit writes fail loudly instead of forking the
 * history. Unfreeze (emergency only, as owner):
 *   DROP TRIGGER security_audit_log_freeze ON security_audit_log;
 *   DROP TRIGGER security_audit_log_freeze_truncate ON security_audit_log;
 *
 * Usage (operator identities: main DATABASE_URL owner-ish; admin side
 * PREFERS ADMIN_DATABASE_URL_MIGRATE — the owner — over ADMIN_DATABASE_URL,
 * because planting rows + setval + historical partition DDL exceed every
 * runtime role's grants ON PURPOSE):
 *   bun scripts/backfill-audit-db.ts               # dry-run plan (default, safe)
 *   bun scripts/backfill-audit-db.ts --apply       # plant + setval + anchor + verify
 *   AUDIT_FREEZE_CONFIRMED=true \
 *     bun scripts/backfill-audit-db.ts --freeze    # verify, then write-freeze main
 *
 * Idempotent + resumable: every insert is ON CONFLICT DO NOTHING on the
 * (id, timestamp) partition key, batches commit in chain_seq order behind a
 * resume watermark, setval never lowers the sequence, and a rerun that finds
 * nothing to plant just re-verifies. Exit 0 only when parity (row counts +
 * head hashes + boundary linkage) AND the full genesis→head verification are
 * green.
 *
 * Rehearsal (never against production):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   cd scripts && ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run __tests__/backfill-audit-db.integration.test.ts
 */

import {
  verifySecurityAuditChain,
  type SecurityChainVerificationResult,
} from '@pagespace/lib/audit/security-audit-chain-verifier';
import type { AdminDatabase } from '@pagespace/db/admin-db';

// ─── cross-module pins (not importable: apps/processor is not a package) ────

/** Chainer advisory-lock key — apps/processor/src/workers/audit-chainer-worker.ts. */
export const CHAINER_ADVISORY_LOCK_KEY = 'audit-chainer';
/** SIEM initialized-but-never-delivered sentinel — apps/processor/src/services/siem-sources.ts. */
export const SIEM_CURSOR_INIT_SENTINEL = '__cursor_init__';

const SIEM_SECURITY_SOURCE = 'security_audit_log';
const DEFAULT_BATCH_SIZE = 1000;
const MAX_PARTITION_MONTHS = 240;

// ─── pure core ───────────────────────────────────────────────────────────────

export interface EmissionEraState {
  count: number;
  minSeq: number;
  earliestPrevHash: string;
}

export interface BackfillStoreState {
  breakGlassArmed: boolean;
  mainCount: number;
  mainMaxSeq: number;
  mainHeadHash: string | null;
  adminLegacyCount: number;
  adminEmission: EmissionEraState | null;
}

export type BackfillPrecondition =
  | { ok: true; state: 'empty_main' | 'pre_chainer' | 'boundary_linked' }
  | {
      ok: false;
      reason: 'break_glass_armed' | 'unlinked_emission_era' | 'boundary_mismatch' | 'seq_collision';
      detail: string;
    };

/**
 * Decide whether planting legacy rows is provably safe. Pure — the shell
 * gathers state, this rules on it. The genesis case is the leaf-7 flagged
 * "chainer ran before backfill" state: refusal is the ONLY correct automated
 * response (see UNLINKED-ERA REMEDIATION in the header).
 */
export function assessBackfillPreconditions(s: BackfillStoreState): BackfillPrecondition {
  if (s.breakGlassArmed) {
    return {
      ok: false,
      reason: 'break_glass_armed',
      detail:
        'ADMIN_DB_BREAK_GLASS=true — audit writes are falling back to the main db, so the legacy table is not static. Disarm break-glass and re-run.',
    };
  }
  if (s.mainCount === 0) {
    return { ok: true, state: 'empty_main' };
  }
  if (s.adminEmission === null) {
    return { ok: true, state: 'pre_chainer' };
  }
  if (s.adminEmission.earliestPrevHash === 'genesis') {
    return {
      ok: false,
      reason: 'unlinked_emission_era',
      detail:
        `The admin store already holds ${s.adminEmission.count} emission-era row(s) chained from 'genesis' — the chainer ran before the backfill, and the legacy and emission eras can no longer be linked in place. ` +
        'Follow the UNLINKED-ERA REMEDIATION section of scripts/backfill-audit-db.ts / infrastructure/UPGRADE.md.',
    };
  }
  if (s.adminEmission.earliestPrevHash !== s.mainHeadHash) {
    return {
      ok: false,
      reason: 'boundary_mismatch',
      detail:
        `The earliest emission-era row links onto ${s.adminEmission.earliestPrevHash}, but the main head is ${s.mainHeadHash ?? '<empty>'} — the main table changed after the era boundary froze (break-glass appends?). ` +
        'Those main-tail rows cannot join the admin chain; reconcile manually before re-running.',
    };
  }
  if (s.adminEmission.minSeq <= s.mainMaxSeq) {
    return {
      ok: false,
      reason: 'seq_collision',
      detail: `Emission-era rows start at chain_seq ${s.adminEmission.minSeq} but the legacy range extends to ${s.mainMaxSeq} — planting would create duplicate chain_seq values.`,
    };
  }
  return { ok: true, state: 'boundary_linked' };
}

/**
 * The setval target after planting: high enough that the chainer's next
 * nextval() exceeds every planted seq, and never LOWER than what the admin
 * sequence already reached (an idempotent rerun must not rewind it under a
 * live emission era). Null = nothing planted anywhere, skip setval
 * (setval below 1 is a Postgres error).
 */
export function planSequenceTarget(i: { mainMaxSeq: number; adminMaxSeq: number }): number | null {
  const target = Math.max(i.mainMaxSeq, i.adminMaxSeq);
  return target > 0 ? target : null;
}

/**
 * The SIEM anchor row to commit LAST (leaf 7 invariant). The admin cursor is
 * authoritative once seeded; before the first post-flip delivery run it does
 * not exist yet, in which case the legacy main cursor holds the watermark the
 * seed WILL copy. Sentinel/absent cursors gate nothing — for those the
 * runbook's backfill-before-first-delivery ordering is the protection.
 */
export function resolveAnchorRowId(i: {
  adminCursorId: string | null;
  mainCursorId: string | null;
}): string | null {
  if (i.adminCursorId !== null && i.adminCursorId !== SIEM_CURSOR_INIT_SENTINEL) {
    return i.adminCursorId;
  }
  if (i.mainCursorId !== null && i.mainCursorId !== SIEM_CURSOR_INIT_SENTINEL) {
    return i.mainCursorId;
  }
  return null;
}

export interface MonthPartition {
  name: string;
  from: string;
  to: string;
}

/**
 * Monthly partitions covering [minTs, maxTs] (Postgres timestamp text), named
 * exactly like drizzle-admin/0002's seeding (security_audit_log_pYYYY_MM).
 * Planting into missing months would silently land rows in the DEFAULT
 * partition — never lost, but it poisons admin_ensure_partitions for those
 * months (Postgres refuses to carve a month out of a non-empty DEFAULT).
 */
export function monthPartitionsForRange(minTs: string, maxTs: string): MonthPartition[] {
  const parse = (ts: string): { y: number; m: number } => {
    const match = /^(\d{4})-(\d{2})/.exec(ts);
    if (!match) throw new Error(`Unparseable timestamp: ${ts}`);
    return { y: Number(match[1]), m: Number(match[2]) };
  };
  const lo = parse(minTs);
  const hi = parse(maxTs);
  const months = (hi.y - lo.y) * 12 + (hi.m - lo.m) + 1;
  if (months < 1 || months > MAX_PARTITION_MONTHS) {
    throw new Error(
      `Refusing to plan ${months} monthly partitions for range ${minTs}..${maxTs} — check the source timestamps.`
    );
  }
  const result: MonthPartition[] = [];
  for (let i = 0; i < months; i++) {
    const y = lo.y + Math.floor((lo.m - 1 + i) / 12);
    const m = ((lo.m - 1 + i) % 12) + 1;
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const pad = (n: number) => String(n).padStart(2, '0');
    result.push({
      name: `security_audit_log_p${y}_${pad(m)}`,
      from: `${y}-${pad(m)}-01`,
      to: `${nextY}-${pad(nextM)}-01`,
    });
  }
  return result;
}

export interface ParityInput {
  mainCount: number;
  adminLegacyCount: number;
  mainHeadHash: string | null;
  adminLegacyHeadHash: string | null;
  /** previous_hash of the earliest emission-era row; null when no emission era exists yet. */
  emissionBoundaryPrevHash: string | null;
}

/** Zero-loss checks: row-count parity, head-hash equality, era-boundary linkage. Pure. */
export function assessBackfillParity(p: ParityInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (p.mainCount !== p.adminLegacyCount) {
    failures.push(
      `row-count mismatch: main has ${p.mainCount} rows, admin holds ${p.adminLegacyCount} legacy rows`
    );
  }
  if (p.mainHeadHash !== p.adminLegacyHeadHash) {
    failures.push(
      `head-hash mismatch: main head ${p.mainHeadHash ?? '<empty>'} vs admin legacy head ${p.adminLegacyHeadHash ?? '<empty>'}`
    );
  }
  if (p.emissionBoundaryPrevHash !== null && p.emissionBoundaryPrevHash !== p.mainHeadHash) {
    failures.push(
      `era-boundary mismatch: earliest emission row links onto ${p.emissionBoundaryPrevHash}, expected the legacy head ${p.mainHeadHash ?? '<empty>'}`
    );
  }
  return { ok: failures.length === 0, failures };
}

export type BackfillCliMode =
  | { ok: true; command: 'plan' | 'apply' | 'freeze' }
  | { ok: false; error: string };

export function resolveBackfillCliMode(
  argv: string[],
  env: Record<string, string | undefined>
): BackfillCliMode {
  const unknown = argv.filter((a) => a !== '--apply' && a !== '--freeze');
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown argument(s): ${unknown.join(', ')} (expected --apply or --freeze)` };
  }
  const apply = argv.includes('--apply');
  const freeze = argv.includes('--freeze');
  if (apply && freeze) {
    return {
      ok: false,
      error:
        'Refusing --apply and --freeze in one run: verify the backfill and confirm SIEM released awaiting_backfill BEFORE freezing (see infrastructure/UPGRADE.md).',
    };
  }
  if (freeze) {
    if (env.AUDIT_FREEZE_CONFIRMED !== 'true') {
      return {
        ok: false,
        error:
          'Refusing to freeze: set AUDIT_FREEZE_CONFIRMED=true only AFTER the backfill verified genesis→head and SIEM resumed delivery. Freezing revokes ALL appends to the legacy table — including break-glass.',
      };
    }
    return { ok: true, command: 'freeze' };
  }
  return { ok: true, command: apply ? 'apply' : 'plan' };
}

export type BackfillEnv =
  | { ok: true; mainUrl: string; adminUrl: string; breakGlassArmed: boolean }
  | { ok: false; error: string };

export function resolveBackfillEnv(env: Record<string, string | undefined>): BackfillEnv {
  const mainUrl = env.DATABASE_URL;
  if (!mainUrl) return { ok: false, error: 'DATABASE_URL is not set (main db, legacy table source)' };
  const adminUrl = env.ADMIN_DATABASE_URL_MIGRATE ?? env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    return {
      ok: false,
      error:
        'Neither ADMIN_DATABASE_URL_MIGRATE nor ADMIN_DATABASE_URL is set — the backfill needs the Admin PG owner identity (runtime roles cannot plant rows or setval).',
    };
  }
  return { ok: true, mainUrl, adminUrl, breakGlassArmed: env.ADMIN_DB_BREAK_GLASS === 'true' };
}

// ─── freeze SQL (pure builders/constants) ────────────────────────────────────

/**
 * The 6 columns admin_gdpr_eraser may UPDATE (drizzle-admin/0002 grant) — the
 * ONLY mutations the frozen legacy table still accepts, because the main-store
 * erasure leg keeps running until the table drops. user_id is in scope (the
 * grant permits future full unlinking) though today's patch retains it.
 */
export const ERASER_MUTABLE_COLUMNS = [
  'user_id',
  'session_id',
  'ip_address',
  'ip_bidx',
  'user_agent',
  'geo_location',
] as const;

/** Every other column — chain content and classification — is immutable once frozen. */
export const FROZEN_IMMUTABLE_COLUMNS = [
  'id',
  'event_type',
  'service_id',
  'resource_type',
  'resource_id',
  'details',
  'risk_score',
  'anomaly_flags',
  'timestamp',
  'chain_seq',
  'previous_hash',
  'event_hash',
] as const;

export const FREEZE_GUARD_FUNCTION_NAME = 'security_audit_log_freeze_guard';
export const FREEZE_TRIGGER_NAME = 'security_audit_log_freeze';
export const FREEZE_TRUNCATE_TRIGGER_NAME = 'security_audit_log_freeze_truncate';

const FREEZE_MESSAGE =
  'security_audit_log is write-frozen: history migrated to the Admin PG (#890 Phase 2 backfill). ' +
  'Only PII-column pseudonymization UPDATEs are permitted until the post-soak DROP. ' +
  'See infrastructure/UPGRADE.md (Phase 2 backfill & freeze).';

export function buildFreezeGuardFunctionSql(): string {
  const immutableChecks = FROZEN_IMMUTABLE_COLUMNS.map(
    (c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`
  ).join('\n        OR ');
  return `
CREATE OR REPLACE FUNCTION ${FREEZE_GUARD_FUNCTION_NAME}() RETURNS trigger
LANGUAGE plpgsql AS $freeze$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ${immutableChecks}
    THEN
      RAISE EXCEPTION '${FREEZE_MESSAGE}';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '${FREEZE_MESSAGE}';
END
$freeze$;`;
}

// Grants are revoked from every current holder INCLUDING the owner's explicit
// grants; the triggers are what actually stop the owner (Postgres owners
// bypass their own ACLs). UPDATE is deliberately NOT revoked — the guard
// trigger scopes it to the eraser columns instead.
const FREEZE_REVOKE_SQL = `
DO $freeze_revoke$
DECLARE g record;
BEGIN
  FOR g IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'security_audit_log'
      AND privilege_type IN ('INSERT', 'DELETE', 'TRUNCATE')
  LOOP
    IF g.grantee = 'PUBLIC' THEN
      REVOKE INSERT, DELETE, TRUNCATE ON security_audit_log FROM PUBLIC;
    ELSE
      EXECUTE format('REVOKE INSERT, DELETE, TRUNCATE ON security_audit_log FROM %I', g.grantee);
    END IF;
  END LOOP;
END
$freeze_revoke$;`;

// ─── imperative shell ────────────────────────────────────────────────────────

export interface QueryExecutor {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PoolLike extends QueryExecutor {
  connect(): Promise<QueryExecutor & { release(): void }>;
}

interface GatheredState extends BackfillStoreState {
  mainMinTs: string | null;
  mainMaxTs: string | null;
  adminMaxSeq: number;
  adminLegacyMaxSeq: number;
  adminLegacyHeadHash: string | null;
  anchorRowId: string | null;
}

const num = (v: unknown): number => Number(v ?? 0);

export async function readCursorId(
  db: QueryExecutor,
  source: string,
  side: 'main' | 'admin'
): Promise<string | null> {
  try {
    const r = await db.query('SELECT "lastDeliveredId" FROM siem_delivery_cursors WHERE id = $1', [
      source,
    ]);
    return (r.rows[0]?.lastDeliveredId as string | undefined) ?? null;
  } catch (error) {
    // 42P01 undefined_table — tolerable only on the MAIN side of odd installs;
    // a missing ADMIN cursors table is a broken admin schema and must abort
    // (falling back to the main cursor would mask it).
    if (side === 'main' && (error as { code?: string }).code === '42P01') return null;
    throw error;
  }
}

export async function gatherBackfillState(deps: {
  main: QueryExecutor;
  admin: QueryExecutor;
  breakGlassArmed: boolean;
}): Promise<GatheredState> {
  const [mainAgg, mainHead, legacyAgg, legacyHead, emissionAgg, emissionEarliest, adminAgg] =
    await Promise.all([
      deps.main.query(
        `SELECT count(*)::text AS count, COALESCE(max(chain_seq), 0)::text AS max_seq,
                min(timestamp)::text AS min_ts, max(timestamp)::text AS max_ts
         FROM security_audit_log`
      ),
      deps.main.query('SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1'),
      deps.admin.query(
        `SELECT count(*)::text AS count, COALESCE(max(chain_seq), 0)::text AS max_seq
         FROM security_audit_log WHERE emission_hash IS NULL`
      ),
      deps.admin.query(
        `SELECT event_hash FROM security_audit_log WHERE emission_hash IS NULL
         ORDER BY chain_seq DESC LIMIT 1`
      ),
      deps.admin.query(
        `SELECT count(*)::text AS count, COALESCE(min(chain_seq), 0)::text AS min_seq
         FROM security_audit_log WHERE emission_hash IS NOT NULL`
      ),
      deps.admin.query(
        `SELECT previous_hash FROM security_audit_log WHERE emission_hash IS NOT NULL
         ORDER BY chain_seq ASC LIMIT 1`
      ),
      deps.admin.query('SELECT COALESCE(max(chain_seq), 0)::text AS max_seq FROM security_audit_log'),
    ]);

  const emissionCount = num(emissionAgg.rows[0]?.count);
  const [adminCursorId, mainCursorId] = await Promise.all([
    readCursorId(deps.admin, SIEM_SECURITY_SOURCE, 'admin'),
    readCursorId(deps.main, SIEM_SECURITY_SOURCE, 'main'),
  ]);

  return {
    breakGlassArmed: deps.breakGlassArmed,
    mainCount: num(mainAgg.rows[0]?.count),
    mainMaxSeq: num(mainAgg.rows[0]?.max_seq),
    mainHeadHash: (mainHead.rows[0]?.event_hash as string | undefined) ?? null,
    mainMinTs: (mainAgg.rows[0]?.min_ts as string | null) ?? null,
    mainMaxTs: (mainAgg.rows[0]?.max_ts as string | null) ?? null,
    adminLegacyCount: num(legacyAgg.rows[0]?.count),
    adminLegacyMaxSeq: num(legacyAgg.rows[0]?.max_seq),
    adminLegacyHeadHash: (legacyHead.rows[0]?.event_hash as string | undefined) ?? null,
    adminEmission:
      emissionCount > 0
        ? {
            count: emissionCount,
            minSeq: num(emissionAgg.rows[0]?.min_seq),
            earliestPrevHash: (emissionEarliest.rows[0]?.previous_hash as string) ?? 'genesis',
          }
        : null,
    adminMaxSeq: num(adminAgg.rows[0]?.max_seq),
    anchorRowId: resolveAnchorRowId({ adminCursorId, mainCursorId }),
  };
}

// Every value travels as text (SELECT-side casts, INSERT-side casts back) so
// no driver type mapping — Date parsing, float4 widening — can perturb a byte
// of what the hash chain covers. The genesis→head verify would catch any
// corruption anyway; text round-tripping makes it a non-event.
const COPY_SELECT_COLUMNS = `id, event_type, user_id, session_id, service_id, resource_type,
        resource_id, ip_address, ip_bidx, user_agent, geo_location,
        details::text AS details, risk_score::text AS risk_score,
        anomaly_flags::text AS anomaly_flags, timestamp::text AS ts,
        chain_seq::text AS chain_seq, previous_hash, event_hash`;

const COPY_INSERT_CASTS = [
  '', '', '', '', '', '', '', '', '', '', '',
  '::jsonb', '::real', '::text[]', '::timestamp', '::bigint', '', '',
];

function buildCopyInsert(rows: Record<string, unknown>[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const fields = [
      r.id, r.event_type, r.user_id, r.session_id, r.service_id, r.resource_type,
      r.resource_id, r.ip_address, r.ip_bidx, r.user_agent, r.geo_location,
      r.details, r.risk_score, r.anomaly_flags, r.ts, r.chain_seq,
      r.previous_hash, r.event_hash,
    ];
    const base = values.length;
    values.push(...fields);
    return `(${fields.map((_, i) => `$${base + i + 1}${COPY_INSERT_CASTS[i]}`).join(', ')})`;
  });
  // emission_hash is deliberately absent → NULL, the legacy-era marker.
  const text = `INSERT INTO security_audit_log
      (id, event_type, user_id, session_id, service_id, resource_type, resource_id,
       ip_address, ip_bidx, user_agent, geo_location, details, risk_score,
       anomaly_flags, timestamp, chain_seq, previous_hash, event_hash)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING`;
  return { text, values };
}

async function copyPass(opts: {
  main: QueryExecutor;
  admin: QueryExecutor;
  fromSeq: number;
  excludeId: string | null;
  batchSize: number;
  journal: string[];
  log: (line: string) => void;
}): Promise<number> {
  let cursor = opts.fromSeq;
  let planted = 0;
  for (;;) {
    const batch = await opts.main.query(
      `SELECT ${COPY_SELECT_COLUMNS}
       FROM security_audit_log
       WHERE chain_seq > $1::bigint AND ($2::text IS NULL OR id <> $2)
       ORDER BY chain_seq ASC
       LIMIT $3`,
      [cursor, opts.excludeId, opts.batchSize]
    );
    if (batch.rows.length === 0) return planted;
    const insert = buildCopyInsert(batch.rows);
    const result = await opts.admin.query(insert.text, insert.values);
    planted += result.rowCount ?? 0;
    cursor = num(batch.rows[batch.rows.length - 1].chain_seq);
    opts.journal.push(`plant:${result.rowCount ?? 0}@seq<=${cursor}`);
    opts.log(`  planted ${planted} rows (through chain_seq ${cursor})…`);
    if (batch.rows.length < opts.batchSize) return planted;
  }
}

async function plantAnchorRow(opts: {
  main: QueryExecutor;
  admin: QueryExecutor;
  anchorRowId: string;
  journal: string[];
}): Promise<boolean> {
  const row = await opts.main.query(
    `SELECT ${COPY_SELECT_COLUMNS} FROM security_audit_log WHERE id = $1`,
    [opts.anchorRowId]
  );
  if (row.rows.length === 0) {
    // Cursor points past the legacy era (already released) — nothing to gate.
    opts.journal.push('anchor:absent-from-main');
    return false;
  }
  const insert = buildCopyInsert(row.rows);
  const result = await opts.admin.query(insert.text, insert.values);
  opts.journal.push(`anchor:${opts.anchorRowId}`);
  return (result.rowCount ?? 0) > 0;
}

async function ensureHistoricalPartitions(opts: {
  admin: QueryExecutor;
  minTs: string;
  maxTs: string;
  journal: string[];
}): Promise<string[]> {
  const created: string[] = [];
  for (const month of monthPartitionsForRange(opts.minTs, opts.maxTs)) {
    const exists = await opts.admin.query('SELECT to_regclass($1) AS reg', [month.name]);
    if (exists.rows[0]?.reg !== null) continue;
    try {
      // Identifiers are script-generated (digits only) — no injection surface.
      await opts.admin.query(
        `CREATE TABLE IF NOT EXISTS ${month.name} PARTITION OF security_audit_log
         FOR VALUES FROM ('${month.from}') TO ('${month.to}')`
      );
      created.push(month.name);
      opts.journal.push(`partition:${month.name}`);
    } catch (error) {
      throw new Error(
        `Failed to create partition ${month.name} — if the DEFAULT partition already holds rows for that month, ` +
          `move them out first (see drizzle-admin/0003 repair note). Cause: ${(error as Error).message}`
      );
    }
  }
  return created;
}

async function alignChainSequence(opts: {
  admin: QueryExecutor;
  target: number;
  journal: string[];
}): Promise<void> {
  // GREATEST with the live last_value: never rewind a sequence the chainer
  // already advanced past the legacy range.
  await opts.admin.query(
    `SELECT setval('security_audit_log_chain_seq_seq',
       GREATEST($1::bigint, (SELECT last_value FROM security_audit_log_chain_seq_seq)))`,
    [opts.target]
  );
  opts.journal.push(`setval:${opts.target}`);
}

export interface BackfillSummary {
  outcome: 'planned' | 'backfilled' | 'aborted';
  precondition: BackfillPrecondition;
  planted: number;
  anchorRowId: string | null;
  anchorPlanted: boolean;
  partitionsCreated: string[];
  sequenceTarget: number | null;
  journal: string[];
  warnings: string[];
  parity: { ok: boolean; failures: string[] } | null;
  verification: SecurityChainVerificationResult | null;
}

export interface BackfillDeps {
  main: QueryExecutor;
  adminPool: PoolLike;
  adminDb: AdminDatabase;
  breakGlassArmed?: boolean;
  batchSize?: number;
  log?: (line: string) => void;
}

/**
 * The full backfill run: chainer-exclusion lock → preconditions → historical
 * partitions → batched seq-ordered copy (anchor excluded) → setval →
 * anchor-committed-last → parity + full genesis→head verification. Plan mode
 * (dryRun) gathers, rules, and reports without taking the lock or writing.
 */
export async function runAuditBackfill(
  deps: BackfillDeps & { dryRun: boolean }
): Promise<BackfillSummary> {
  const log = deps.log ?? (() => {});
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const breakGlassArmed = deps.breakGlassArmed ?? false;
  const journal: string[] = [];
  const warnings: string[] = [];

  const summarize = (
    outcome: BackfillSummary['outcome'],
    precondition: BackfillPrecondition,
    rest: Partial<BackfillSummary> = {}
  ): BackfillSummary => ({
    outcome,
    precondition,
    planted: 0,
    anchorRowId: null,
    anchorPlanted: false,
    partitionsCreated: [],
    sequenceTarget: null,
    journal,
    warnings,
    parity: null,
    verification: null,
    ...rest,
  });

  if (deps.dryRun) {
    const state = await gatherBackfillState({
      main: deps.main,
      admin: deps.adminPool,
      breakGlassArmed,
    });
    const precondition = assessBackfillPreconditions(state);
    log(
      `PLAN: main=${state.mainCount} rows (max seq ${state.mainMaxSeq}), admin legacy=${state.adminLegacyCount}, ` +
        `emission era=${state.adminEmission ? `${state.adminEmission.count} rows from seq ${state.adminEmission.minSeq}` : 'none'}, ` +
        `anchor row=${state.anchorRowId ?? 'none'}`
    );
    if (!precondition.ok) {
      log(`WOULD ABORT (${precondition.reason}): ${precondition.detail}`);
      return summarize('aborted', precondition, { anchorRowId: state.anchorRowId });
    }
    log(
      `Would plant ~${Math.max(state.mainCount - state.adminLegacyCount, 0)} rows, ` +
        `setval → ${planSequenceTarget({ mainMaxSeq: state.mainMaxSeq, adminMaxSeq: state.adminMaxSeq }) ?? 'skip'}, ` +
        `then verify genesis→head.`
    );
    return summarize('planned', precondition, { anchorRowId: state.anchorRowId });
  }

  // Hold the chainer's own advisory lock for the entire live run: even a
  // processor someone forgot to stop is provably excluded while rows are
  // planted and the sequence is aligned. Session lock on a dedicated
  // connection; pg_advisory_lock BLOCKS until any in-flight chainer cycle
  // finishes rather than racing it.
  const lockClient = await deps.adminPool.connect();
  let locked = false;
  try {
    log(`Acquiring chainer exclusion lock ('${CHAINER_ADVISORY_LOCK_KEY}')…`);
    await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [CHAINER_ADVISORY_LOCK_KEY]);
    locked = true;

    // Gather UNDER the lock — the chainer cannot move the boundary anymore.
    let state = await gatherBackfillState({
      main: deps.main,
      admin: deps.adminPool,
      breakGlassArmed,
    });
    const precondition = assessBackfillPreconditions(state);
    if (!precondition.ok) {
      log(`ABORT (${precondition.reason}): ${precondition.detail}`);
      return summarize('aborted', precondition, { anchorRowId: state.anchorRowId });
    }
    if (precondition.ok && precondition.state === 'empty_main') {
      log('Main security_audit_log is empty — nothing to backfill.');
      return summarize('backfilled', precondition, {
        parity: { ok: true, failures: [] },
        verification: await verifySecurityAuditChain({ stopOnFirstBreak: true }, { db: deps.adminDb }),
      });
    }

    const anchorRowId = state.anchorRowId;
    if (anchorRowId !== null && state.adminLegacyCount === 0) {
      // First run: sanity — the anchor gate is what makes mid-backfill
      // visibility safe; note when there is none to gate on.
      log(`Anchor row (SIEM cursor watermark): ${anchorRowId} — committed last.`);
    }
    if (anchorRowId === null) {
      warnings.push(
        'No SIEM anchor row (cursor absent or __cursor_init__): per the runbook this backfill MUST complete before the first post-flip SIEM delivery run.'
      );
    }

    const partitionsCreated =
      state.mainMinTs && state.mainMaxTs
        ? await ensureHistoricalPartitions({
            admin: deps.adminPool,
            minTs: state.mainMinTs,
            maxTs: state.mainMaxTs,
            journal,
          })
        : [];

    // Batched, resumable copy in chain_seq order, anchor row excluded.
    let planted = await copyPass({
      main: deps.main,
      admin: deps.adminPool,
      fromSeq: state.adminLegacyMaxSeq,
      excludeId: anchorRowId,
      batchSize,
      journal,
      log,
    });

    // Align the sequence BEFORE the anchor row becomes visible and BEFORE the
    // lock is released — from the chainer's next run onward, nextval() is
    // beyond every legacy seq.
    const sequenceTarget = planSequenceTarget({
      mainMaxSeq: state.mainMaxSeq,
      adminMaxSeq: state.adminMaxSeq,
    });
    if (sequenceTarget !== null) {
      await alignChainSequence({ admin: deps.adminPool, target: sequenceTarget, journal });
      log(`Sequence aligned: security_audit_log_chain_seq_seq → ${sequenceTarget}.`);
    }

    // Anchor-committed-last: the moment this row is visible, every legacy row
    // already is — the SIEM deferral releases into a complete history.
    let anchorPlanted = false;
    if (anchorRowId !== null) {
      anchorPlanted = await plantAnchorRow({
        main: deps.main,
        admin: deps.adminPool,
        anchorRowId,
        journal,
      });
      planted += anchorPlanted ? 1 : 0;
      log(`Anchor row ${anchorRowId} ${anchorPlanted ? 'planted' : 'already present / not a legacy row'}.`);
    }

    // Parity; on count mismatch run ONE full recovery rescan (covers holes a
    // crashed earlier run could theoretically leave) before failing.
    state = await gatherBackfillState({ main: deps.main, admin: deps.adminPool, breakGlassArmed });
    if (state.mainCount !== state.adminLegacyCount) {
      warnings.push(
        `count mismatch after primary pass (main=${state.mainCount}, admin legacy=${state.adminLegacyCount}) — running full rescan`
      );
      const rescanned = await copyPass({
        main: deps.main,
        admin: deps.adminPool,
        fromSeq: 0,
        excludeId: null,
        batchSize,
        journal,
        log,
      });
      journal.push(`rescan:${rescanned}`);
      planted += rescanned;
      if (state.mainMaxSeq > 0) {
        await alignChainSequence({ admin: deps.adminPool, target: state.mainMaxSeq, journal });
      }
      state = await gatherBackfillState({ main: deps.main, admin: deps.adminPool, breakGlassArmed });
    }

    const parity = assessBackfillParity({
      mainCount: state.mainCount,
      adminLegacyCount: state.adminLegacyCount,
      mainHeadHash: state.mainHeadHash,
      adminLegacyHeadHash: state.adminLegacyHeadHash,
      emissionBoundaryPrevHash: state.adminEmission?.earliestPrevHash ?? null,
    });
    for (const failure of parity.failures) log(`PARITY FAILURE: ${failure}`);

    // The leaf's core proof: the WHOLE admin chain — legacy era, boundary,
    // emission era — verifies genesis→head, era-aware (leaf 5 verifier).
    log('Verifying admin chain genesis→head…');
    const verification = await verifySecurityAuditChain(
      { stopOnFirstBreak: true },
      { db: deps.adminDb }
    );
    log(
      `Verification: isValid=${verification.isValid} entries=${verification.entriesVerified}/${verification.totalEntries}` +
        (verification.breakPoint ? ` BREAK: ${verification.breakPoint.description}` : '')
    );

    return summarize('backfilled', precondition, {
      planted,
      anchorRowId,
      anchorPlanted,
      partitionsCreated,
      sequenceTarget,
      parity,
      verification,
    });
  } finally {
    if (locked) {
      await lockClient
        .query('SELECT pg_advisory_unlock(hashtext($1))', [CHAINER_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

export interface FreezeSummary {
  outcome: 'frozen' | 'refused';
  refusals: string[];
  parity: { ok: boolean; failures: string[] } | null;
  verification: SecurityChainVerificationResult | null;
}

/**
 * Write-freeze the legacy main table — only after re-proving parity and the
 * full admin chain in the same invocation, so a freeze can never seal a
 * store that disagrees with the history it supposedly preserved.
 */
export async function freezeLegacySecurityAuditLog(deps: {
  main: QueryExecutor;
  admin: QueryExecutor;
  adminDb: AdminDatabase;
  breakGlassArmed?: boolean;
  log?: (line: string) => void;
}): Promise<FreezeSummary> {
  const log = deps.log ?? (() => {});
  const refusals: string[] = [];

  const state = await gatherBackfillState({
    main: deps.main,
    admin: deps.admin,
    breakGlassArmed: deps.breakGlassArmed ?? false,
  });
  if (state.breakGlassArmed) {
    refusals.push('ADMIN_DB_BREAK_GLASS=true — break-glass writes to the main table; freezing now would break the active audit path.');
  }
  if (state.mainCount > 0 && state.adminLegacyCount === 0) {
    refusals.push('The admin store holds no legacy rows — run the backfill (--apply) first.');
  }

  const parity =
    state.mainCount === 0
      ? { ok: true, failures: [] }
      : assessBackfillParity({
          mainCount: state.mainCount,
          adminLegacyCount: state.adminLegacyCount,
          mainHeadHash: state.mainHeadHash,
          adminLegacyHeadHash: state.adminLegacyHeadHash,
          emissionBoundaryPrevHash: state.adminEmission?.earliestPrevHash ?? null,
        });
  if (!parity.ok) refusals.push(...parity.failures);

  let verification: SecurityChainVerificationResult | null = null;
  if (refusals.length === 0) {
    verification = await verifySecurityAuditChain({ stopOnFirstBreak: true }, { db: deps.adminDb });
    if (!verification.isValid) {
      refusals.push(
        `Admin chain verification failed: ${verification.breakPoint?.description ?? 'invalid entries'}`
      );
    }
  }

  if (refusals.length > 0) {
    for (const r of refusals) log(`FREEZE REFUSED: ${r}`);
    return { outcome: 'refused', refusals, parity, verification };
  }

  log('Freezing main security_audit_log (revoke + guard triggers)…');
  await deps.main.query(buildFreezeGuardFunctionSql());
  await deps.main.query(`DROP TRIGGER IF EXISTS ${FREEZE_TRIGGER_NAME} ON security_audit_log`);
  await deps.main.query(
    `CREATE TRIGGER ${FREEZE_TRIGGER_NAME}
     BEFORE INSERT OR UPDATE OR DELETE ON security_audit_log
     FOR EACH ROW EXECUTE FUNCTION ${FREEZE_GUARD_FUNCTION_NAME}()`
  );
  await deps.main.query(
    `DROP TRIGGER IF EXISTS ${FREEZE_TRUNCATE_TRIGGER_NAME} ON security_audit_log`
  );
  await deps.main.query(
    `CREATE TRIGGER ${FREEZE_TRUNCATE_TRIGGER_NAME}
     BEFORE TRUNCATE ON security_audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION ${FREEZE_GUARD_FUNCTION_NAME}()`
  );
  await deps.main.query(FREEZE_REVOKE_SQL);
  log('Legacy table frozen: INSERT/DELETE/TRUNCATE raise; UPDATE limited to eraser PII columns.');

  return { outcome: 'frozen', refusals: [], parity, verification };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  (async () => {
    // scripts/ has no package.json, so pg/dotenv are not resolvable from here
    // directly — borrow @pagespace/db's module context (its own driver).
    const { createRequire } = await import('node:module');
    const requireFromDb = createRequire(
      createRequire(import.meta.url).resolve('@pagespace/db/db')
    );
    requireFromDb('dotenv/config');

    const mode = resolveBackfillCliMode(process.argv.slice(2), process.env);
    if (!mode.ok) {
      console.error(`❌ ${mode.error}`);
      process.exit(1);
    }
    const env = resolveBackfillEnv(process.env);
    if (!env.ok) {
      console.error(`❌ ${env.error}`);
      process.exit(1);
    }

    const { Pool } = requireFromDb('pg') as unknown as {
      Pool: new (config: Record<string, unknown>) => PoolLike & { end(): Promise<void> };
    };
    const { createAdminAuditDbClient } = await import('@pagespace/db/admin-eraser-db');

    const mainPool = new Pool({ connectionString: env.mainUrl, max: 3 });
    const adminPool = new Pool({
      connectionString: env.adminUrl,
      max: 4,
      ssl:
        process.env.ADMIN_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    const adminClient = createAdminAuditDbClient({
      connectionString: env.adminUrl,
      ssl: process.env.ADMIN_DATABASE_SSL === 'true',
    });

    const log = (line: string) => console.log(line);
    let exitCode = 1;
    try {
      if (mode.command === 'freeze') {
        const result = await freezeLegacySecurityAuditLog({
          main: mainPool,
          admin: adminPool,
          adminDb: adminClient.db,
          breakGlassArmed: env.breakGlassArmed,
          log,
        });
        exitCode = result.outcome === 'frozen' ? 0 : 1;
        console.log(
          result.outcome === 'frozen'
            ? '✅ Legacy security_audit_log write-frozen. Break-glass can no longer append to it (documented, accepted).'
            : `❌ Freeze refused:\n  - ${result.refusals.join('\n  - ')}`
        );
      } else {
        const result = await runAuditBackfill({
          main: mainPool,
          adminPool,
          adminDb: adminClient.db,
          breakGlassArmed: env.breakGlassArmed,
          dryRun: mode.command === 'plan',
          log,
        });
        const green =
          result.outcome === 'planned' ||
          (result.outcome === 'backfilled' &&
            result.parity?.ok === true &&
            result.verification?.isValid === true);
        exitCode = green ? 0 : 1;
        for (const w of result.warnings) console.warn(`⚠ ${w}`);
        console.log(
          `${green ? '✅' : '❌'} ${result.outcome}: planted=${result.planted} ` +
            `partitions=${result.partitionsCreated.length} setval=${result.sequenceTarget ?? 'skipped'} ` +
            `anchor=${result.anchorRowId ?? 'none'}${result.anchorPlanted ? ' (planted last)' : ''} ` +
            `parity=${result.parity ? (result.parity.ok ? 'ok' : 'FAILED') : 'n/a'} ` +
            `verify=${result.verification ? (result.verification.isValid ? `GREEN (${result.verification.entriesVerified} entries)` : 'FAILED') : 'n/a'}`
        );
      }
    } catch (error) {
      console.error('❌ backfill-audit-db failed:', error);
      exitCode = 1;
    } finally {
      await Promise.all([mainPool.end(), adminPool.end(), adminClient.end()]).catch(() => undefined);
    }
    process.exit(exitCode);
  })();
}

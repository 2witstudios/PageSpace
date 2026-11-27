/**
 * `migratePlaneMetadata` — applies the plane metadata DB's pending migrations
 * (slice 1, deploy). I/O only; the decision is `planPlaneMigrations`.
 *
 * One connection, one transaction: a transaction-scoped advisory lock
 * serializes concurrent runs (two deploys racing), the history table is read
 * under it, and every pending file plus its history row commits together or
 * not at all. Run with the DB OWNER credential as a one-shot before the plane
 * deploys; the plane process itself never runs DDL and connects as a
 * least-privilege user. Never imported by the plane or by apps/web.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { planPlaneMigrations, type PlaneMigrationPlan } from './plan-plane-migrations';

export type PlaneMigrationSource = { readonly name: string; readonly checksum: string; readonly sql: string };

/** The subset of a `pg` client the runner uses, so a test can hand it a real client or a recorder. */
export type MigrationClient = {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[] }>;
  release: () => void;
};
export type MigrationPool = { connect: () => Promise<MigrationClient> };

export type PlaneMigrationResult = { readonly ok: true; readonly applied: readonly string[] } | Extract<PlaneMigrationPlan, { ok: false }>;

/** Lock key for `pg_advisory_xact_lock(hashtext(...))`; distinct from every per-secret and per-tenant key. */
export const PLANE_MIGRATION_LOCK_KEY = 'agent-accounts:plane-metadata:migrate';
export const PLANE_MIGRATIONS_DIR = __dirname;

export function readPlaneMigrationSources(dir: string = PLANE_MIGRATIONS_DIR): readonly PlaneMigrationSource[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migratePlaneMetadata({
  pool,
  sources,
}: {
  readonly pool: MigrationPool;
  readonly sources: readonly PlaneMigrationSource[];
}): Promise<PlaneMigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [PLANE_MIGRATION_LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS plane_metadata_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query('SELECT name, checksum FROM plane_metadata_migrations ORDER BY name');
    const applied = rows.map((row) => ({ name: String(row.name), checksum: String(row.checksum) }));
    const plan = planPlaneMigrations({ available: sources, applied });
    if (!plan.ok) {
      await client.query('ROLLBACK');
      return plan;
    }
    const byName = new Map(sources.map((source) => [source.name, source]));
    for (const name of plan.pending) {
      const source = byName.get(name)!;
      await client.query(source.sql);
      await client.query('INSERT INTO plane_metadata_migrations (name, checksum) VALUES ($1, $2)', [source.name, source.checksum]);
    }
    await client.query('COMMIT');
    return { ok: true, applied: plan.pending };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

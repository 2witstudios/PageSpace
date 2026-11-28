/**
 * `planPlaneMigrations` — which plane metadata migrations are pending. Pure.
 *
 * The plane metadata DB (ADR 0005 §2.5) has no Drizzle schema: its DDL is the
 * ordered raw SQL files beside this module. The runner records each applied
 * file's name and checksum; this decides what to apply next, or refuses when
 * the DB's recorded history and the files on disk disagree. A refusal names
 * the file, never guesses: applying around a changed or missing file would
 * leave a schema nobody wrote.
 */

export type PlaneMigrationFile = { readonly name: string; readonly checksum: string };

export type PlaneMigrationPlan =
  | { readonly ok: true; readonly pending: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: 'no_migrations' | 'bad_name' | 'duplicate_number' | 'checksum_mismatch' | 'applied_unknown' | 'out_of_order';
      readonly name: string | null;
    };

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function planPlaneMigrations({
  available,
  applied,
}: {
  readonly available: readonly PlaneMigrationFile[];
  readonly applied: readonly PlaneMigrationFile[];
}): PlaneMigrationPlan {
  if (available.length === 0) return { ok: false, reason: 'no_migrations', name: null };
  const sorted = [...available].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const numbers = new Set<string>();
  for (const migration of sorted) {
    const match = MIGRATION_NAME.exec(migration.name);
    if (match === null) return { ok: false, reason: 'bad_name', name: migration.name };
    if (numbers.has(match[1]!)) return { ok: false, reason: 'duplicate_number', name: migration.name };
    numbers.add(match[1]!);
  }

  const byName = new Map(sorted.map((migration) => [migration.name, migration]));
  for (const record of applied) {
    const onDisk = byName.get(record.name);
    if (onDisk === undefined) return { ok: false, reason: 'applied_unknown', name: record.name };
    if (onDisk.checksum !== record.checksum) return { ok: false, reason: 'checksum_mismatch', name: record.name };
  }

  // The recorded history must be exactly the first N files: a file that sorts before an applied one
  // was added after the DB moved past it, and running it now would apply changes out of order.
  const appliedNames = new Set(applied.map((record) => record.name));
  const firstPending = sorted.findIndex((migration) => !appliedNames.has(migration.name));
  if (firstPending === -1) return { ok: true, pending: [] };
  const rest = sorted.slice(firstPending);
  const stray = rest.find((migration) => appliedNames.has(migration.name));
  if (stray !== undefined) return { ok: false, reason: 'out_of_order', name: sorted[firstPending]!.name };
  return { ok: true, pending: rest.map((migration) => migration.name) };
}

/**
 * The connection string the migration one-shot uses. On Fly the one-shot runs
 * in the plane's app and inherits its runtime PLANE_METADATA_DATABASE_URL (a
 * login that cannot run DDL; an app secret beats a same-named --env), so the
 * owner URL travels as PLANE_METADATA_DATABASE_URL_MIGRATE and wins when set.
 * Blank counts as unset. Local dev and CI set only the runtime name.
 */
export function selectPlaneMigrationUrl(env: {
  readonly PLANE_METADATA_DATABASE_URL_MIGRATE?: string | undefined;
  readonly PLANE_METADATA_DATABASE_URL?: string | undefined;
}): string | null {
  const owner = env.PLANE_METADATA_DATABASE_URL_MIGRATE?.trim() ?? '';
  if (owner.length > 0) return owner;
  const runtime = env.PLANE_METADATA_DATABASE_URL?.trim() ?? '';
  return runtime.length > 0 ? runtime : null;
}

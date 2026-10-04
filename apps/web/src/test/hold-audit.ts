import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';

/**
 * Count every credit hold placed and removed for some users while `fn` runs, from inside
 * Postgres: an AFTER INSERT / AFTER DELETE trigger on credit_holds writes each one to a scratch
 * table. "No hold is left" is all a suite can see from the rows that survive; this sees the ones
 * that came and went, so a regression to several holds per model call (each settled or
 * released) cannot pass as one (technique from ow-irv-2742 on #2742).
 *
 * The trigger, its function and the scratch table are dropped in `finally`, whatever `fn` does.
 */
export interface HoldAudit {
  /** Holds inserted for each user, in order. */
  placed: Map<string, string[]>;
  /** Holds deleted (settled, released or swept) for each user, in order. */
  removed: Map<string, string[]>;
}

export async function withHoldAudit<T>(userIds: string[], fn: () => Promise<T>, settled?: () => Promise<void>): Promise<{ result: T; audit: HoldAudit }> {
  const name = `test_hold_audit_${createId().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const users = userIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  await db.execute(sql.raw(`CREATE TABLE ${name} (seq bigserial PRIMARY KEY, op text NOT NULL, "userId" text NOT NULL, "holdId" text NOT NULL)`));
  await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."userId" IN (${users}) THEN INSERT INTO ${name} (op, "userId", "holdId") VALUES ('placed', NEW."userId", NEW.id); END IF;
        RETURN NEW;
      END IF;
      IF OLD."userId" IN (${users}) THEN INSERT INTO ${name} (op, "userId", "holdId") VALUES ('removed', OLD."userId", OLD.id); END IF;
      RETURN OLD;
    END $$ LANGUAGE plpgsql`));
  await db.execute(sql.raw(`CREATE TRIGGER ${name} AFTER INSERT OR DELETE ON credit_holds FOR EACH ROW EXECUTE FUNCTION ${name}()`));
  try {
    const result = await fn();
    if (settled) await settled();
    const rows = (await db.execute(sql.raw(`SELECT op, "userId", "holdId" FROM ${name} ORDER BY seq`))).rows as { op: string; userId: string; holdId: string }[];
    const audit: HoldAudit = { placed: new Map(), removed: new Map() };
    for (const id of userIds) {
      audit.placed.set(id, []);
      audit.removed.set(id, []);
    }
    for (const row of rows) (row.op === 'placed' ? audit.placed : audit.removed).get(row.userId)?.push(row.holdId);
    return { result, audit };
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON credit_holds`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${name}`));
  }
}

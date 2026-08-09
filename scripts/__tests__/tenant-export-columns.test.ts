/**
 * DRIFT GUARD for the tenant export's column registry.
 *
 * `scripts/lib/tenant-export-columns.ts` is a forced copy of the Drizzle
 * schema — the export builds hand-written INSERTs, so every carried column has
 * to be named somewhere — and a forced copy drifts. When it does, the failure
 * is SILENT in the worst possible way: the bundle still imports, and the
 * un-named column's data is simply absent from the tenant forever.
 *
 * So this test derives the expected column set from the Drizzle table objects
 * AT RUNTIME (`getTableColumns`) and requires the registry to account for every
 * one of them, in both directions:
 *
 *   1. every schema column is carried or explicitly excluded  → catches an
 *      ADDED column that nobody decided about (the actual historical failure);
 *   2. every registry name exists in the schema               → catches a
 *      RENAMED or DROPPED column left behind in the list, which would make the
 *      import abort on an unknown column;
 *   3. carried ∩ excluded = ∅, and every exclusion states a reason  → keeps
 *      "not carried" a decision someone wrote down rather than an omission.
 *
 * It needs no database: the table objects describe themselves.
 *
 * SCOPE: the first describe below guards the COLUMNS of the tables the export
 * carries. The second guards which TABLES are carried, over the agent-session
 * FK closure — see its own header for why that boundary and not the whole
 * schema.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as dbSchema from '@pagespace/db/schema';
import { TABLE_IMPORT_ORDER, type ExportTableName } from '../lib/migration-types';
import {
  TENANT_EXPORT_COLUMNS,
  TENANT_EXPORT_EXCLUDED_TABLES,
  carriedColumns,
  exportColumns,
  deferredColumns,
} from '../lib/tenant-export-columns';

/** Every pgTable the db package exports, keyed by its real SQL table name. */
function schemaTablesByName(): Map<string, PgTable> {
  const byName = new Map<string, PgTable>();
  for (const value of Object.values(dbSchema as Record<string, unknown>)) {
    if (value && is(value, PgTable)) {
      byName.set(getTableName(value), value);
    }
  }
  return byName;
}

const TABLES = schemaTablesByName();

function schemaColumnNames(table: ExportTableName): string[] {
  const pgTable = TABLES.get(table);
  if (!pgTable) {
    throw new Error(
      `No Drizzle table named "${table}" is exported from @pagespace/db/schema — ` +
      'the export bundle names a table the schema does not define.',
    );
  }
  return Object.values(getTableColumns(pgTable)).map((c) => c.name);
}

describe('tenant export column registry', () => {
  it('covers exactly the tables in TABLE_IMPORT_ORDER', () => {
    expect(Object.keys(TENANT_EXPORT_COLUMNS).sort()).toEqual(
      [...TABLE_IMPORT_ORDER].sort(),
    );
  });

  it.each([...TABLE_IMPORT_ORDER])(
    '%s: every schema column is carried or explicitly excluded',
    (table) => {
      const spec = TENANT_EXPORT_COLUMNS[table];
      const accounted = new Set([
        ...carriedColumns(table),
        ...Object.keys(spec.excluded ?? {}),
      ]);

      const unaccounted = schemaColumnNames(table).filter((c) => !accounted.has(c));

      expect(
        unaccounted,
        `${table}: ${unaccounted.join(', ')} exist in packages/db/src/schema but are ` +
        'neither carried by the tenant export nor listed in its exclusion allowlist. ' +
        'Add them to `columns` (or to `excluded` with a reason) in ' +
        'scripts/lib/tenant-export-columns.ts — an unlisted column is dropped silently ' +
        'by every tenant migration.',
      ).toEqual([]);
    },
  );

  it.each([...TABLE_IMPORT_ORDER])(
    '%s: every registered column still exists in the schema',
    (table) => {
      const spec = TENANT_EXPORT_COLUMNS[table];
      const schemaColumns = new Set(schemaColumnNames(table));
      const registered = [...carriedColumns(table), ...Object.keys(spec.excluded ?? {})];

      const phantom = registered.filter((c) => !schemaColumns.has(c));

      expect(
        phantom,
        `${table}: ${phantom.join(', ')} are registered by the tenant export but no ` +
        'longer exist in packages/db/src/schema. A dropped or renamed column left in ' +
        'the list makes the generated INSERT fail against the tenant database.',
      ).toEqual([]);
    },
  );

  it.each([...TABLE_IMPORT_ORDER])(
    '%s: carried and excluded columns do not overlap, and no name repeats',
    (table) => {
      const spec = TENANT_EXPORT_COLUMNS[table];
      const carried = carriedColumns(table);
      const excluded = Object.keys(spec.excluded ?? {});

      expect(new Set(carried).size, `${table}: duplicate column in the carried list`)
        .toBe(carried.length);
      expect(
        carried.filter((c) => excluded.includes(c)),
        `${table}: a column cannot be both carried and excluded`,
      ).toEqual([]);
      // A deferred column is carried by a trailing UPDATE INSTEAD of the
      // INSERT, never by both.
      expect(
        deferredColumns(table).filter((c) => exportColumns(table).includes(c)),
        `${table}: a deferred column must not also ride the INSERT`,
      ).toEqual([]);
    },
  );

  it('states a reason for every deliberately excluded column', () => {
    for (const table of TABLE_IMPORT_ORDER) {
      for (const [column, reason] of Object.entries(TENANT_EXPORT_COLUMNS[table].excluded ?? {})) {
        expect(
          reason.trim().length,
          `${table}.${column} is excluded from the tenant export with no stated reason`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it('only defers columns on tables that have an id to key the UPDATE on', () => {
    for (const table of TABLE_IMPORT_ORDER) {
      if (deferredColumns(table).length === 0) continue;
      expect(
        schemaColumnNames(table),
        `${table} defers columns but has no "id" column for the trailing UPDATE`,
      ).toContain('id');
    }
  });

  it('carries the columns whose loss motivated this guard', () => {
    // Regression pins for the eighteen columns the hand-maintained lists had
    // silently dropped. Named individually so a future edit that removes one
    // fails with the column, not just a set difference.
    const pins: Partial<Record<ExportTableName, string[]>> = {
      users: ['emailBidx', 'imageGenerationModel', 'activeUploads'],
      drives: ['publishSubdomain', 'homePageId', 'not_found_page_id', 'publish_default_og_image_url', 'publish_favicon_url'],
      pages: ['toolExposureMode', 'sandboxEnabled', 'userScopedAccess', 'description', 'isPrivate', 'createdBy'],
      channel_messages: ['editedAt', 'parentId', 'replyCount', 'lastReplyAt', 'mirroredFromId', 'quotedMessageId'],
      // `workspaceId` and `closedInWorkspaceAt` were pinned here too. Both
      // columns are dropped: a thread's workspace is an `agent_workspace_nodes`
      // row, so the pin moved off this table and the decision about the table
      // that replaced it is the one the registry now records as open.
      conversations: ['rev', 'isShared', 'agentPageId'],
      messages: ['sourceAgentId'],
      // The terminal half of a session. `coldTail` is the one carried column
      // that is irreplaceable user OUTPUT rather than configuration: it is
      // overwritten in place on every teardown and has no other home in the
      // bundle, so a migration that drops it loses the scrollback outright.
      agent_workspace_shells: ['coldTail', 'coldTailHasOutput', 'name', 'command'],
    };

    for (const [table, columns] of Object.entries(pins) as [ExportTableName, string[]][]) {
      for (const column of columns) {
        expect(carriedColumns(table), `${table}.${column}`).toContain(column);
      }
    }
  });
});

/**
 * The FK closure of the agent-session tables: every table reachable by foreign
 * key from `agent_workspaces` or `conversations`, transitively. Derived from
 * the schema at runtime for the same reason the column set is — a hand-written
 * copy is what drifted in the first place.
 */
function agentSessionFkClosure(): string[] {
  const referencesOf = new Map<string, string[]>();
  for (const table of TABLES.values()) {
    referencesOf.set(
      getTableName(table),
      getTableConfig(table).foreignKeys.map((fk) => getTableName(fk.reference().foreignTable)),
    );
  }

  const closure = new Set(['agent_workspaces', 'conversations']);
  // Bounded fixpoint: each pass can only add tables, and there are finitely
  // many, so |TABLES| passes is guaranteed to saturate.
  for (let pass = 0; pass < referencesOf.size; pass++) {
    const before = closure.size;
    for (const [table, references] of referencesOf) {
      if (references.some((ref) => closure.has(ref))) closure.add(table);
    }
    if (closure.size === before) break;
  }
  return [...closure].sort();
}

/**
 * DRIFT GUARD for which TABLES a tenant bundle carries.
 *
 * The column registry above cannot see this class of loss at all: a table
 * absent from `TABLE_IMPORT_ORDER` has no columns to check, so dropping the
 * whole thing is invisible to every assertion in it. That is exactly how
 * `agent_workspace_shells` came to be carried by the GDPR export and dropped
 * by the tenant one — the shell scrollback (`coldTail`) simply did not travel,
 * and nothing said so.
 *
 * WHY THE FK CLOSURE AND NOT THE WHOLE SCHEMA. A "you forgot this table"
 * assertion is only meaningful where the bundle already carries the PARENT
 * row: those are the tables whose absence is silent data loss for a user who
 * did migrate, rather than a feature the bundle was never scoped to
 * (`credit_ledger`, `audit_logs`, `ai_usage_logs` — instance accounting that
 * belongs to the source deployment). Anchoring on `agent_workspaces` and
 * `conversations` makes the guard exactly as wide as the region this epic
 * moved user work into, and it is derived, so a new child table added to
 * either one is caught without anyone remembering to widen a list.
 */
describe('tenant export table registry', () => {
  it('records a carry-or-exclude decision for every table hanging off a session or a thread', () => {
    const decided = new Set<string>([
      ...TABLE_IMPORT_ORDER,
      ...Object.keys(TENANT_EXPORT_EXCLUDED_TABLES),
    ]);

    const undecided = agentSessionFkClosure().filter((table) => !decided.has(table));

    expect(
      undecided,
      `${undecided.join(', ')} reference a table the tenant export carries, but nothing ` +
      'says whether they travel. Add them to TABLE_IMPORT_ORDER (plus a spec in ' +
      'TENANT_EXPORT_COLUMNS and a query in tenant-export.ts / tenant-validate.ts), or to ' +
      'TENANT_EXPORT_EXCLUDED_TABLES with a reason. A table nobody decided about is ' +
      'dropped from every tenant migration and no test notices.',
    ).toEqual([]);
  });

  it('states a reason for every deliberately excluded table, and excludes nothing it also carries', () => {
    const carried = new Set<string>(TABLE_IMPORT_ORDER);
    for (const [table, reason] of Object.entries(TENANT_EXPORT_EXCLUDED_TABLES)) {
      expect(TABLES.has(table), `${table} is excluded but no such table exists in the schema`).toBe(true);
      expect(
        carried.has(table),
        `${table} is listed as excluded AND appears in TABLE_IMPORT_ORDER`,
      ).toBe(false);
      expect(
        reason.trim().length,
        `${table} is excluded from the tenant export with no stated reason`,
      ).toBeGreaterThan(20);
    }
  });

  it('carries the session tables whose loss motivated this guard', () => {
    // The named half of the decision, pinned so a future edit that quietly
    // drops the table fails with the table, not just a set difference.
    expect(TABLE_IMPORT_ORDER).toContain('agent_workspace_shells');
    // …and the excluded half, pinned for the same reason: `ai_stream_sessions`
    // must stay a WRITTEN DOWN exclusion. Its content is reachable on Art 15
    // through the GDPR export's `stream-state.json`; the two exports answer
    // different questions and are allowed to differ, but only out loud.
    expect(Object.keys(TENANT_EXPORT_EXCLUDED_TABLES)).toContain('ai_stream_sessions');
  });
});

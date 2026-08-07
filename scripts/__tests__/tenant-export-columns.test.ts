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
 * SCOPE: this guards the COLUMNS of the tables the export carries. Whether the
 * right set of TABLES is carried is a separate question, owned by
 * `TABLE_IMPORT_ORDER`; the coverage test below only pins the two lists to
 * each other so a new table cannot be added to one and forgotten in the other.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as dbSchema from '@pagespace/db/schema';
import { TABLE_IMPORT_ORDER, type ExportTableName } from '../lib/migration-types';
import {
  TENANT_EXPORT_COLUMNS,
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
      conversations: ['sessionId', 'closedInSessionAt', 'rev', 'isShared'],
      messages: ['pageId', 'sourceAgentId'],
    };

    for (const [table, columns] of Object.entries(pins) as [ExportTableName, string[]][]) {
      for (const column of columns) {
        expect(carriedColumns(table), `${table}.${column}`).toContain(column);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as dbSchema from '@pagespace/db/schema';
import { CONTENT_REF_TABLE_NAMES } from '../page-content-store';

/**
 * Reclaim is only as safe as its reference check is complete: a table holding a
 * `contentRef` that the check does not consult would make `deletePageContent`
 * see no references for a blob that is still in use, and delete it.
 *
 * The store derives its table list from the schema, so the two can only diverge
 * if that derivation breaks. This asserts it against an independent walk, and
 * pins the tables we know about so a barrel regression that silently empties
 * the list cannot pass.
 */
function tablesWithContentRef(): string[] {
  const names: string[] = [];
  for (const value of Object.values(dbSchema as Record<string, unknown>)) {
    if (value && is(value, PgTable) && 'contentRef' in getTableColumns(value)) {
      names.push(getTableName(value));
    }
  }
  return [...new Set(names)].sort();
}

describe('content ref reclaim coverage', () => {
  it('consults every table in the schema that holds a contentRef', () => {
    expect(CONTENT_REF_TABLE_NAMES).toEqual(tablesWithContentRef());
  });

  it('covers the tables known to hold one', () => {
    // Pinned so an empty derivation — a broken barrel, a drizzle upgrade that
    // changes `is(value, PgTable)` — fails loudly instead of reporting that
    // nothing anywhere references any blob.
    expect(CONTENT_REF_TABLE_NAMES).toEqual(
      expect.arrayContaining(['page_versions', 'activity_logs'])
    );
  });
});

// Lint-rule fixture for the unbounded-findMany ESLint rule (eslint.config.mjs).
// The rule must catch findMany() through ANY handle exposing the Drizzle relational query
// API (db.transaction's `tx`, an injected `database`, etc.) — not just a literal `db`
// identifier. This codebase uses `tx.query.<table>.findMany` for real (see
// src/app/api/pages/bulk-copy/route.ts, src/app/api/upload/complete/route.ts).
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

export async function getChildPagesUnboundedViaTx(parentId: string) {
  return db.transaction(async (tx) => {
    // Fixture: unbounded findMany through a non-`db` handle — do not "fix" by adding a
    // limit, that would defeat the point of this file.
    // eslint-disable-next-line no-restricted-syntax
    return tx.query.pages.findMany({
      where: eq(pages.parentId, parentId),
    });
  });
}

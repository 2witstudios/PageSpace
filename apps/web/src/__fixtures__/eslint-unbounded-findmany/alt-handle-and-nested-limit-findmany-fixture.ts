// Lint-rule fixtures for the unbounded-findMany ESLint rule (apps/web/eslint.config.mjs).
// Not real application code. Covers two edge cases the rule must handle beyond a plain
// `db.query.<table>.findMany`: findMany reached through a non-`db` handle (this codebase's
// `db.transaction`-scoped `tx`, e.g. src/app/api/pages/bulk-copy/route.ts), and a `limit`
// that only bounds a nested relation rather than the root query.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

export async function getChildPagesUnboundedViaTx(parentId: string) {
  return db.transaction(async (tx) => {
    // Do not "fix" by adding a limit — that would defeat the point of this function.
    // eslint-disable-next-line no-restricted-syntax
    return tx.query.pages.findMany({
      where: eq(pages.parentId, parentId),
    });
  });
}

export async function getChildPagesLimitedViaTx(parentId: string) {
  return db.transaction(async (tx) => {
    return tx.query.pages.findMany({
      where: eq(pages.parentId, parentId),
      limit: 50,
    });
  });
}

export async function getPagesWithOnlyNestedLimit(driveId: string) {
  // The `limit` below only bounds the nested `children` relation, not this root
  // findMany — the rule must still flag this as unbounded at the top level.
  // eslint-disable-next-line no-restricted-syntax
  return db.query.pages.findMany({
    where: eq(pages.driveId, driveId),
    with: {
      children: {
        limit: 10,
      },
    },
  });
}

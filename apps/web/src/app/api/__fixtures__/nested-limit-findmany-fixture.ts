// Lint-rule fixture for the unbounded-findMany ESLint rule (eslint.config.mjs).
// A `limit` nested inside a `with: { ... }` relation bounds only that relation, not the
// root query — the rule must still flag this as unbounded at the top level.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

export async function getPagesWithOnlyNestedLimit(driveId: string) {
  // Fixture: `limit` here only bounds the nested `children` relation, not this root
  // findMany — do not "fix" by treating the nested limit as sufficient.
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

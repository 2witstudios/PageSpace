// Lint-rule fixture for the unbounded-findMany ESLint rule (eslint.config.mjs).
// Sibling to alt-handle-findmany-fixture.ts: same non-`db` handle, but with a top-level
// `limit` — must pass lint, proving the rule doesn't over-fire on bounded tx queries.
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

export async function getChildPagesLimitedViaTx(parentId: string) {
  return db.transaction(async (tx) => {
    return tx.query.pages.findMany({
      where: eq(pages.parentId, parentId),
      limit: 50,
    });
  });
}

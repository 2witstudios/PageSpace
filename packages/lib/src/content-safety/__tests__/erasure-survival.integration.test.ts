/**
 * Content-safety records OUTLIVE the account they name, against a REAL Postgres.
 *
 * Cases and blocks exist for legal preservation. Account deletion removes the
 * `users` row and lets foreign-key cascades sweep the rest; these tables carry
 * no foreign keys precisely so that sweep cannot reach them. The schema test
 * pins the "no FK" shape — this walks an actual deletion to prove the outcome.
 *
 * Requires a live `DATABASE_URL` with migrations applied; fails loudly without
 * one (requireDb), following the erasure suite's integration tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { contentBlocks, contentCases } from '@pagespace/db/schema/content-safety';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { accountRepository } from '../../repositories/account-repository';

const HASH = createHash('sha256').update(randomUUID()).digest('hex');

describe('content-safety records survive account deletion — real Postgres', () => {
  let userId: string;
  let caseId: string;

  beforeAll(async () => {
    try {
      const user = await factories.createUser();
      userId = user.id;
      const [opened] = await db
        .insert(contentCases)
        .values({
          targetType: 'user',
          targetId: userId,
          contentHash: HASH,
          category: 'policy',
          reporterUserId: userId,
          reason: 'integration test',
          snapshot: { uploaderUserId: userId },
        })
        .returning({ id: contentCases.id });
      caseId = opened.id;
      await db
        .insert(contentBlocks)
        .values({ contentHash: HASH, category: 'policy', source: 'admin', caseId, createdBy: userId });
    } catch (error) {
      requireDb('erasure-survival.integration.test.ts', error);
      throw error;
    }
  });

  afterAll(async () => {
    await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, HASH));
    await db.delete(contentCases).where(eq(contentCases.id, caseId));
  });

  it('keeps the case and the block, IDs intact, after the user they name is deleted', async () => {
    await accountRepository.deleteUser(userId);

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    const [survivingCase] = await db.select().from(contentCases).where(eq(contentCases.id, caseId));
    const [survivingBlock] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, HASH));

    expect(user).toBeUndefined();
    expect(survivingCase).toMatchObject({
      targetId: userId,
      reporterUserId: userId,
      status: 'open',
      snapshot: { uploaderUserId: userId },
    });
    expect(survivingBlock).toMatchObject({ caseId, createdBy: userId });
  });
});

/**
 * The blocklist lookup against a REAL Postgres. The unit test mocks the query
 * builder, so only this proves the lookup reads the right table and column.
 *
 * Requires a live `DATABASE_URL` with migrations applied; fails loudly without
 * one (requireDb), following the erasure suite's integration tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { contentBlocks } from '@pagespace/db/schema/content-safety';
import { requireDb } from '@pagespace/db/test/require-db';
import { findBlockedHashes, isHashBlocked } from '../blocklist';

const freshHash = () => createHash('sha256').update(randomUUID()).digest('hex');

const BLOCKED = freshHash();
const ALSO_BLOCKED = freshHash();
const CLEAN = freshHash();

describe('content blocklist — real Postgres', () => {
  beforeAll(async () => {
    try {
      await db.insert(contentBlocks).values([
        { contentHash: BLOCKED, category: 'policy', source: 'admin', createdBy: 'admin-1' },
        // No admin and no case: a hash-match block has neither.
        { contentHash: ALSO_BLOCKED, category: 'csam', source: 'hash_match' },
      ]);
    } catch (error) {
      requireDb('blocklist.integration.test.ts', error);
      throw error;
    }
  });

  afterAll(async () => {
    await db.delete(contentBlocks).where(inArray(contentBlocks.contentHash, [BLOCKED, ALSO_BLOCKED]));
  });

  it('finds a blocked hash', async () => {
    expect(await isHashBlocked(BLOCKED)).toBe(true);
  });

  it('finds a blocked hash supplied in upper case', async () => {
    expect(await isHashBlocked(BLOCKED.toUpperCase())).toBe(true);
  });

  it('does not find a hash that is not on the list', async () => {
    expect(await isHashBlocked(CLEAN)).toBe(false);
  });

  it('returns exactly the blocked subset of a batch', async () => {
    expect(await findBlockedHashes([CLEAN, BLOCKED, ALSO_BLOCKED])).toEqual(new Set([BLOCKED, ALSO_BLOCKED]));
  });
});

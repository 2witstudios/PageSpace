/**
 * `sessionRepository.revokeAllForResource` — REAL Postgres. What it must get
 * right is a predicate, and predicates are proved against the database, not a
 * fake: exactly the LIVE sessions of ONE resource are revoked, other resources
 * and already-revoked rows are untouched (their original reason survives).
 *
 * Runs in CI (the Unit Tests job provides Postgres). Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/auth/__tests__/session-repository-resource.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { sessionRepository } from '../session-repository';

const userId = createId();
const envA = `env_${createId()}`;
const envB = `env_${createId()}`;
const hashes = { a1: `h_${createId()}`, a2: `h_${createId()}`, aOld: `h_${createId()}`, b1: `h_${createId()}`, userOnly: `h_${createId()}` };
const EARLIER = new Date('2026-09-01T00:00:00.000Z');

async function insertSession(tokenHash: string, over: Partial<typeof sessions.$inferInsert> = {}) {
  await db.insert(sessions).values({
    tokenHash,
    tokenPrefix: 'mcp_',
    userId,
    type: 'mcp',
    scopes: ['env:bridge'],
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...over,
  });
}

const rowOf = async (tokenHash: string) => (await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)))[0];

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `env-revoke-${userId}@test.local`, name: 'Env Revoke', updatedAt: new Date() }).onConflictDoNothing();
  await insertSession(hashes.a1, { resourceType: 'drive_env', resourceId: envA });
  await insertSession(hashes.a2, { resourceType: 'drive_env', resourceId: envA });
  await insertSession(hashes.aOld, { resourceType: 'drive_env', resourceId: envA, revokedAt: EARLIER, revokedReason: 'earlier' });
  await insertSession(hashes.b1, { resourceType: 'drive_env', resourceId: envB });
  await insertSession(hashes.userOnly, {});
});

afterAll(async () => {
  await db.delete(sessions).where(inArray(sessions.tokenHash, Object.values(hashes)));
  await db.delete(users).where(eq(users.id, userId));
});

describe('sessionRepository.revokeAllForResource', () => {
  it("given three sessions on env A (one already revoked) and others elsewhere, should revoke exactly A's two live ones with the reason, and report 2", async () => {
    expect(await sessionRepository.revokeAllForResource('drive_env', envA, 'env_revoked')).toBe(2);
    for (const hash of [hashes.a1, hashes.a2]) {
      const row = await rowOf(hash);
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.revokedReason).toBe('env_revoked');
      expect(await sessionRepository.findActiveSession(hash)).toBeUndefined();
    }
  });

  it('should leave the already-revoked row with its ORIGINAL stamp and reason (revokedAt IS NULL is in the predicate)', async () => {
    const row = await rowOf(hashes.aOld);
    expect(row?.revokedAt?.getTime()).toBe(EARLIER.getTime());
    expect(row?.revokedReason).toBe('earlier');
  });

  it("should not touch another env's session nor the user's unbound session", async () => {
    expect((await rowOf(hashes.b1))?.revokedAt).toBeNull();
    expect((await rowOf(hashes.userOnly))?.revokedAt).toBeNull();
    expect(await sessionRepository.findActiveSession(hashes.b1)).toBeDefined();
  });

  it('should be idempotent: a repeat finds nothing live and reports 0', async () => {
    expect(await sessionRepository.revokeAllForResource('drive_env', envA, 'again')).toBe(0);
    expect((await rowOf(hashes.a1))?.revokedReason).toBe('env_revoked');
  });

  it('should scope by resourceType too: the same id under another type is not this resource', async () => {
    expect(await sessionRepository.revokeAllForResource('other_type', envB, 'x')).toBe(0);
    expect((await rowOf(hashes.b1))?.revokedAt).toBeNull();
  });
});

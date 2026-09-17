/**
 * The Apple token store against a real Postgres: the (user, client) conflict
 * key that makes each sign-in replace rather than accumulate tokens, and the
 * users FK cascade that is erasure's backstop for any row a revoke step missed.
 *
 *   bun run --filter '@pagespace/lib' test:integration -- src/auth/apple/__tests__/apple-token-store.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users, appleSignInTokens } from '@pagespace/db/schema/auth';
import { appleTokenStore } from '../apple-token-store';

describe('appleTokenStore (integration)', () => {
  it('given a second sign-in with the same Apple client, should replace the stored token rather than add one', async () => {
    const user = await factories.createUser();

    await appleTokenStore.upsert({ userId: user.id, clientId: 'ai.pagespace.ios', encryptedRefreshToken: 'cipher-1' });
    await appleTokenStore.upsert({ userId: user.id, clientId: 'ai.pagespace.ios', encryptedRefreshToken: 'cipher-2' });

    expect(await appleTokenStore.listForUser(user.id)).toEqual([{ clientId: 'ai.pagespace.ios', refreshToken: 'cipher-2' }]);
  });

  it('given sign-ins from the native app and the web, should keep one token per client', async () => {
    const user = await factories.createUser();

    await appleTokenStore.upsert({ userId: user.id, clientId: 'ai.pagespace.ios', encryptedRefreshToken: 'native' });
    await appleTokenStore.upsert({ userId: user.id, clientId: 'ai.pagespace.web', encryptedRefreshToken: 'web' });

    const rows = await appleTokenStore.listForUser(user.id);
    expect(rows.map((r) => r.clientId).sort()).toEqual(['ai.pagespace.ios', 'ai.pagespace.web']);
    expect(await appleTokenStore.hasForUser(user.id)).toBe(true);
  });

  it('given deleteForUser, should remove only that user\'s tokens', async () => {
    const subject = await factories.createUser();
    const bystander = await factories.createUser();
    await appleTokenStore.upsert({ userId: subject.id, clientId: 'ai.pagespace.ios', encryptedRefreshToken: 's' });
    await appleTokenStore.upsert({ userId: bystander.id, clientId: 'ai.pagespace.ios', encryptedRefreshToken: 'b' });

    expect(await appleTokenStore.deleteForUser(subject.id)).toBe(1);

    expect(await appleTokenStore.hasForUser(subject.id)).toBe(false);
    expect(await appleTokenStore.hasForUser(bystander.id)).toBe(true);
  });

  it('given the user row is deleted, should cascade the stored tokens away', async () => {
    const user = await factories.createUser();
    await appleTokenStore.upsert({ userId: user.id, clientId: 'ai.pagespace.ios', encryptedRefreshToken: 'c' });

    await db.delete(users).where(eq(users.id, user.id));

    const remaining = await db.select().from(appleSignInTokens).where(eq(appleSignInTokens.userId, user.id));
    expect(remaining).toEqual([]);
  });
});

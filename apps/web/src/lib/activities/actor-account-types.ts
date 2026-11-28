import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';

/**
 * Agent Signup Phase 2c, fork ruling (a). Activity rows carry the actor's name
 * as stored at write time; the agent marker is resolved at READ time from the
 * actor's live `users.accountType`, so it also covers rows written before agent
 * accounts existed. An erased actor (userId set null, or no user row) gets null
 * and keeps its stored name unmarked. One query per call, for distinct actors.
 */
export async function withActorAccountTypes<T extends { userId: string | null }>(
  rows: readonly T[],
): Promise<(T & { actorAccountType: string | null })[]> {
  const ids = [...new Set(rows.map((row) => row.userId).filter((id): id is string => typeof id === 'string'))];
  const byId = new Map<string, string>();
  if (ids.length > 0) {
    const found = await db
      .select({ id: users.id, accountType: users.accountType })
      .from(users)
      .where(inArray(users.id, ids));
    for (const user of found) byId.set(user.id, user.accountType);
  }
  return rows.map((row) => ({ ...row, actorAccountType: (row.userId && byId.get(row.userId)) || null }));
}

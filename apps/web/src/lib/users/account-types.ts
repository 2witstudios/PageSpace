import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';

export type AccountTypeValue = 'human' | 'agent';

/**
 * `users.accountType` for a bounded set of ids, in one query — for result lists
 * assembled from several sources (profiles, connections) that never selected
 * it. Lets a picker mark an AI agent account whose name is self-chosen (Agent
 * Signup Phase 2b). An id with no row is absent from the map; callers treat
 * absent as human, the column default.
 */
export async function loadAccountTypes(userIds: readonly string[]): Promise<Map<string, AccountTypeValue>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, accountType: users.accountType })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row.accountType]));
}

import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';

type UserLike = { id: string; name?: string | null; email?: string | null } & Record<string, unknown>;

interface TaskRelationsShape {
  assignee?: UserLike | null;
  user?: UserLike | null;
  assignees?: ReadonlyArray<{ user?: UserLike | null } & Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Decrypt the `name` (and `email`, if present) on every embedded user relation
 * across a batch of task rows — assignee, user, assignees[].user. GDPR PII
 * encryption means these come back as ciphertext unless decrypted at the edge.
 * Dedupes decrypt work per unique user id across the whole batch.
 */
export async function decryptTaskUserRelations<T extends TaskRelationsShape>(
  tasks: readonly T[],
): Promise<T[]> {
  const allUsers: UserLike[] = [];
  for (const t of tasks) {
    if (t.assignee) allUsers.push(t.assignee);
    if (t.user) allUsers.push(t.user);
    if (t.assignees) for (const a of t.assignees) if (a.user) allUsers.push(a.user);
  }
  if (allUsers.length === 0) return tasks.slice();

  const decryptedById = await decryptUsersByIdOnce(allUsers);

  return tasks.map((t) => ({
    ...t,
    assignee: t.assignee ? (decryptedById.get(t.assignee.id) ?? t.assignee) : t.assignee,
    user: t.user ? (decryptedById.get(t.user.id) ?? t.user) : t.user,
    assignees: t.assignees?.map((a) => ({
      ...a,
      user: a.user ? (decryptedById.get(a.user.id) ?? a.user) : a.user,
    })),
  })) as T[];
}

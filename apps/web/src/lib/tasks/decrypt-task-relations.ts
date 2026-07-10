import { decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';

type UserLike = { id: string; name?: string | null; email?: string | null } & Record<string, unknown>;

interface TaskRelationsShape {
  assignee?: UserLike | null;
  user?: UserLike | null;
  assignees?: ReadonlyArray<{ user?: UserLike | null } & Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Decrypt the `name` (and `email`, if selected) on every embedded user relation
 * across a batch of task rows — assignee, user, assignees[].user. GDPR PII
 * encryption means these come back as ciphertext unless decrypted at the edge.
 *
 * Each unique user id is decrypted once per batch. The same user can be selected
 * with different column sets across relations (e.g. assignee selects `image`,
 * assignees[].user does not), so projections are merged for decryption and only
 * the PII fields each relation actually selected are overlaid back — the
 * original row shape is always preserved.
 *
 * A row whose ciphertext fails to decrypt keeps its stored value (the pre-encryption
 * rendering behavior) rather than failing the whole response.
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

  const decryptedById = await decryptPiiByIdOnce(allUsers);

  const overlay = (user: UserLike | null | undefined) => {
    if (!user) return user;
    const decrypted = decryptedById.get(user.id);
    if (!decrypted) return user;
    const out: UserLike = { ...user };
    if ('name' in user) out.name = decrypted.name;
    if ('email' in user) out.email = decrypted.email;
    return out;
  };

  return tasks.map((t) => ({
    ...t,
    assignee: overlay(t.assignee),
    user: overlay(t.user),
    assignees: t.assignees?.map((a) => ({ ...a, user: overlay(a.user) })),
  })) as T[];
}

/** Single-task convenience wrapper around {@link decryptTaskUserRelations} (null/undefined pass through). */
export async function decryptTaskUserRelationsOne<T extends TaskRelationsShape>(task: T): Promise<T>;
export async function decryptTaskUserRelationsOne<T extends TaskRelationsShape>(
  task: T | undefined,
): Promise<T | undefined>;
export async function decryptTaskUserRelationsOne<T extends TaskRelationsShape>(
  task: T | null,
): Promise<T | null>;
export async function decryptTaskUserRelationsOne<T extends TaskRelationsShape>(
  task: T | null | undefined,
): Promise<T | null | undefined> {
  if (!task) return task;
  const [decrypted] = await decryptTaskUserRelations([task]);
  return decrypted;
}

/**
 * Merge every projection of the same user id (union of the selected columns),
 * then decrypt each merged row once. A per-user decrypt failure falls back to
 * that user's stored row instead of rejecting the batch.
 */
async function decryptPiiByIdOnce(users: readonly UserLike[]): Promise<Map<string, UserLike>> {
  const mergedById = new Map<string, UserLike>();
  for (const u of users) {
    const prev = mergedById.get(u.id);
    mergedById.set(u.id, prev ? { ...prev, ...u } : u);
  }

  const entries = await Promise.all(
    Array.from(mergedById.entries()).map(async ([id, row]) => {
      try {
        return [id, await decryptUserRow(row)] as const;
      } catch (error) {
        loggers.api.warn('Task relations: user PII decrypt failed; returning stored value', {
          userId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        return [id, row] as const;
      }
    }),
  );
  return new Map(entries);
}

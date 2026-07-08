import { z } from 'zod/v4';

/**
 * Query-param parsing + in-memory search/sort helpers for the paginated
 * admin users list.
 *
 * Search and sort run in Node (not SQL) on purpose: `users.name` and
 * `users.email` hold AES-256-GCM ciphertext at rest (GDPR #965), so SQL
 * ILIKE/ORDER BY over those columns is meaningless. The route loads a light
 * projection of every user, decrypts via the standard decryptUserRows
 * pattern, filters/sorts here, and only then runs the expensive enrichment
 * (stats aggregates, Stripe lookups) for the requested page.
 */

export const DORMANT_DAYS = 30;

export const listUsersParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(200).default(''),
  sort: z.enum(['name', 'email', 'created', 'lastActive', 'tier']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  dormant: z.enum(['true', 'false']).optional(),
  suspended: z.enum(['true', 'false']).optional(),
});

export type ListUsersParams = z.infer<typeof listUsersParamsSchema>;

export function parseListUsersParams(url: URL): ListUsersParams | null {
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    raw[key] = value;
  }
  const parsed = listUsersParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface SortableUser {
  name: string | null;
  email: string | null;
  currentAiProvider: string | null;
  subscriptionTier: string;
  createdAt: Date;
  lastActiveAt: Date | null;
}

export function matchesSearch(user: SortableUser, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return (
    (user.name ?? '').toLowerCase().includes(normalizedQuery) ||
    (user.email ?? '').toLowerCase().includes(normalizedQuery) ||
    (user.currentAiProvider ?? '').toLowerCase().includes(normalizedQuery)
  );
}

export function isDormant(lastActiveAt: Date | null, now = Date.now()): boolean {
  if (!lastActiveAt) return true;
  return now - lastActiveAt.getTime() > DORMANT_DAYS * 24 * 60 * 60 * 1000;
}

const TIER_RANK: Record<string, number> = { free: 0, pro: 1, founder: 2, business: 3 };

/** Ascending comparator for the given sort key. Callers negate for desc. */
export function compareUsers(sort: ListUsersParams['sort']): (a: SortableUser, b: SortableUser) => number {
  switch (sort) {
    case 'email':
      return (a, b) => (a.email ?? '').localeCompare(b.email ?? '');
    case 'created':
      return (a, b) => a.createdAt.getTime() - b.createdAt.getTime();
    case 'lastActive':
      // Never-active users sort as oldest.
      return (a, b) => (a.lastActiveAt?.getTime() ?? 0) - (b.lastActiveAt?.getTime() ?? 0);
    case 'tier':
      return (a, b) => (TIER_RANK[a.subscriptionTier] ?? 0) - (TIER_RANK[b.subscriptionTier] ?? 0);
    case 'name':
    default:
      return (a, b) => (a.name ?? '').localeCompare(b.name ?? '');
  }
}

import { z } from 'zod/v4';
import { tierRank, toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

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

// Dormancy lives in the shared module; re-exported here because the route
// and the list-params tests import it alongside the other list helpers.
export { DORMANT_DAYS, isDormant } from '@/lib/dormancy';

export const listUsersParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  // Clamp instead of reject — an over-long paste into the search box must
  // degrade to a truncated search, not 400 the whole list.
  q: z.string().trim().transform((s) => s.slice(0, 200)).default(''),
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
      return (a, b) =>
        tierRank(toSubscriptionTier(a.subscriptionTier)) - tierRank(toSubscriptionTier(b.subscriptionTier));
    case 'name':
    default:
      return (a, b) => (a.name ?? '').localeCompare(b.name ?? '');
  }
}

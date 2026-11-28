'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';

/** `GET /api/orgs`: the organizations the person belongs to, with their own role in each. */
export interface MyOrganization {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  /** [D-OW-33] the org's subscription has lapsed: its drives may only restrict access until it pays. */
  lapsed?: boolean;
  /** DRV-3: whether this person may create a drive in the org now (policy, role, not lapsed). */
  canCreateDrives?: boolean;
}

const fetcher = async (url: string): Promise<MyOrganization[]> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  const body = (await response.json()) as { organizations?: MyOrganization[] };
  return body.organizations ?? [];
};

/**
 * The person's organizations (names for org-owned drives).
 * The ONE reader of GET /api/orgs: every surface (the picker, the crumb, Account Settings, the org hub)
 * shares this cache entry and its shape, so an org:changed refresh (X-4) reaches all of them.
 */
export function useMyOrganizations() {
  const { data, error, isLoading, mutate } = useSWR<MyOrganization[]>('/api/orgs', fetcher, {
    revalidateOnFocus: false,
  });
  const organizations = data ?? [];
  return {
    /** Undefined until the first answer arrives (a list that is still loading is not an empty one). */
    loaded: data,
    organizations,
    orgById: (orgId: string | null | undefined) => (orgId ? organizations.find((o) => o.id === orgId) ?? null : null),
    error,
    isLoading,
    refresh: mutate,
  };
}

'use client';

import useSWR from 'swr';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/** `GET /api/orgs`: the organizations the person belongs to, with their own role in each. */
export interface MyOrganization {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  /** [D-OW-33] the org's subscription has lapsed: its drives may only restrict access until it pays. */
  lapsed?: boolean;
}

const fetcher = async (url: string): Promise<MyOrganization[]> => {
  const response = await fetchWithAuth(url);
  // Orgs dark on the server answers a bare 404: no orgs, not an error.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  const body = (await response.json()) as { organizations?: MyOrganization[] };
  return body.organizations ?? [];
};

/** The person's organizations (names for org-owned drives). No request while organizations are dark. */
export function useMyOrganizations() {
  const { data, error, isLoading, mutate } = useSWR<MyOrganization[]>(ORGS_ENABLED ? '/api/orgs' : null, fetcher, {
    revalidateOnFocus: false,
  });
  const organizations = data ?? [];
  return {
    organizations,
    orgById: (orgId: string | null | undefined) => (orgId ? organizations.find((o) => o.id === orgId) ?? null : null),
    error,
    isLoading,
    refresh: mutate,
  };
}

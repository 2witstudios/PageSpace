'use client';

import useSWR from 'swr';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface MemberRow {
  userId: string;
  user: { name: string | null } | null;
  profile: { displayName: string | null } | null;
}

const fetcher = async (url: string): Promise<Record<string, string>> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) return {};
  const body = (await response.json()) as { members?: MemberRow[] };
  const names: Record<string, string> = {};
  for (const m of body.members ?? []) {
    const name = m.profile?.displayName || m.user?.name;
    if (name) names[m.userId] = name;
  }
  return names;
};

/**
 * Display names of a drive's members by user id (GET /api/drives/[driveId]/members), so the
 * automation surfaces can say whom a workflow spends as (D-OW-34) without a second source of names.
 * No request while organizations are dark.
 */
export function useDriveMemberNames(driveId: string | null): Record<string, string> {
  const { data } = useSWR<Record<string, string>>(ORGS_ENABLED && driveId ? `/api/drives/${encodeURIComponent(driveId)}/members` : null, fetcher, {
    revalidateOnFocus: false,
  });
  return data ?? {};
}

'use client';

import { usePathname } from 'next/navigation';
import { useDriveStore } from '@/hooks/useDrive';
import { useMyOrganizations } from '@/hooks/useMyOrganizations';
import { orgIdForSurface } from '@/lib/orgs/org-surface';

/** The org the current screen belongs to, when the viewer is a member of it (orgIdForSurface); undefined otherwise. */
export function useSurfaceOrgId(): string | undefined {
  const pathname = usePathname();
  const drives = useDriveStore((state) => state.drives);
  const { orgById } = useMyOrganizations();
  return orgIdForSurface((orgId) => orgById(orgId) !== null, pathname, drives) ?? undefined;
}

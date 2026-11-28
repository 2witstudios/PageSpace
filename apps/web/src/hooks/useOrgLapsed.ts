'use client';

import { useMyOrganizations } from '@/hooks/useMyOrganizations';

/**
 * [D-OW-33] Is this drive's org lapsed? While it is, the drive may only RESTRICT access: the screens disable what the
 * routes would refuse with 402 org_lapsed. False for a personal drive, or for an org the person is not in (a guest
 * admin then meets the server's refusal instead of a disabled control).
 */
export function useOrgLapsed(orgId: string | null | undefined): boolean {
  const { orgById } = useMyOrganizations();
  return orgById(orgId)?.lapsed === true;
}

/** The note shown under a control a lapsed org may not use (the org settings pages' PausedWhileUnpaid wording). */
export const LAPSED_LOOSEN_NOTE = "Paused while this drive's organization is unpaid. Removing access and lowering roles still work.";

/** Org role ranks, pure (no IO): the one place the ordering MEMBER < ADMIN < OWNER is written. */
import type { OrgRole } from '@pagespace/db/schema/organizations';

export const ORG_ROLE_RANK: Readonly<Record<OrgRole, number>> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

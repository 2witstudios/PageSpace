/** Needs your attention (canvas OrgAttention): pure copy for a guest request. */
import type { GuestApproval } from './org-api';
import { formatOrgShortDate } from './org-format';

/** Drive roles (MemberRole): a page-link GUEST views; the others read by name. */
const ROLE_WORD: Record<string, string> = { GUEST: 'View', MEMBER: 'Member', ADMIN: 'Admin', OWNER: 'Owner' };

export function guestRequestCopy(item: GuestApproval): { who: string; wants: string; facts: string[]; viaLink: boolean } {
  const who = item.requesterName ?? item.email ?? 'Someone';
  const access = item.request.role ? `${ROLE_WORD[item.request.role] ?? 'Custom'} access` : item.request.customRoleId ? 'a custom role' : 'access';
  const pages = item.request.pageGrants > 0 ? `${item.request.pageGrants} ${item.request.pageGrants === 1 ? 'page' : 'pages'}` : 'whole drive';
  const tokens = item.request.tokenScopes > 0 ? `${item.request.tokenScopes} ${item.request.tokenScopes === 1 ? 'scope' : 'scopes'}` : 'none';
  const expiry = formatOrgShortDate(item.request.earliestExpiry);
  return {
    who,
    wants: `Wants ${access} in`,
    facts: [`Pages: ${pages}`, `API token: ${tokens}`, `Expires: ${expiry ?? 'no expiry'}`],
    viaLink: item.request.viaLink,
  };
}

/**
 * `decideAccountListView` — whether a person may see an agent page's account
 * list (L2·G2 review LOW-2). Decided from their standing on the page BEFORE
 * any account row is read, so the answer never reveals whether the page has
 * accounts. The bar is `view` on an agent-page-owned account (ADR 0004 §4.1):
 * a drive OWNER/ADMIN, or a member who can edit the page. Pure.
 */
import type { DriveRoleOfHuman } from './account-permissions';

export function decideAccountListView({ humanDriveRole, pagePermission }: { readonly humanDriveRole: DriveRoleOfHuman; readonly pagePermission: 'edit' | 'view' | 'none' }): boolean {
  if (humanDriveRole === 'OWNER' || humanDriveRole === 'ADMIN') return true;
  return humanDriveRole === 'MEMBER' && pagePermission === 'edit';
}

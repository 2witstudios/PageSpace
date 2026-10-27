/**
 * policy-suspension-names — the suspended-items list as the Policies page renders it (Spec POL-1,
 * UI-7): every item carries its drive's name, a suspended guest's name, and a ready label, so the
 * UI never resolves a raw id. Names only, never content (no page titles, no link targets).
 *
 * Which drive names a viewer may read is the Drives directory's decision (listOrgDriveDirectory,
 * D-OW-25): a drive the viewer would not see there keeps a null name and a generic label.
 */
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { decryptUserRow } from '../auth/user-repository';
import { listOrgDriveDirectory } from '../permissions/org-drive-directory';
import type { PolicySuspensionItem, SuspendedListing, SuspendedResourceType } from './policy-suspension';

export interface NamedSuspensionItem extends PolicySuspensionItem {
  driveName: string | null;
  /** Only guests: the suspended person's name. */
  userName: string | null;
  label: string;
}

export interface NamedSuspendedListing extends Omit<SuspendedListing, 'items'> {
  items: NamedSuspensionItem[];
}

const WHAT: Record<SuspendedResourceType, string> = {
  drive_share_link: 'Drive share link',
  page_share_link: 'Page share link',
  published_page: 'Published page',
  custom_domain: 'Custom domain',
  integration_connection: 'Integration connection',
  guest_hold: 'Guest',
};

/** The item's one-line label: what it is, who (a guest), and where. */
export function suspensionLabel(input: { resourceType: SuspendedResourceType; driveName: string | null; userName: string | null }): string {
  const what = input.resourceType === 'guest_hold' && input.userName ? `Guest ${input.userName}` : WHAT[input.resourceType];
  return input.driveName ? `${what} in ${input.driveName}` : what;
}

/** Name every item of `listings` for `viewerId` (an Owner or Admin of `orgId`). */
export async function nameSuspensions(orgId: string, viewerId: string, listings: SuspendedListing[]): Promise<NamedSuspendedListing[]> {
  const directory = (await listOrgDriveDirectory(orgId, viewerId)) ?? [];
  const driveNames = new Map(directory.map((d) => [d.id, d.name]));
  const userIds = [...new Set(listings.flatMap((l) => l.items.flatMap((i) => (i.userId ? [i.userId] : []))))];
  const userNames = new Map<string, string>();
  if (userIds.length > 0) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
    for (const row of rows) {
      const name = (await decryptUserRow({ name: row.name })).name;
      if (name) userNames.set(row.id, name);
    }
  }
  return listings.map((listing) => ({
    ...listing,
    items: listing.items.map((item) => {
      const driveName = driveNames.get(item.driveId) ?? null;
      const userName = item.userId ? userNames.get(item.userId) ?? null : null;
      return { ...item, driveName, userName, label: suspensionLabel({ resourceType: item.resourceType, driveName, userName }) };
    }),
  }));
}

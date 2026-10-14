'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isBillingEnabled, isOnPrem } from '@/retained/lib/deployment-mode';
import { isNativeApp } from '@/retained/lib/capacitor-bridge';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useMyOrganizations } from '@/retained/hooks/useMyOrganizations';
import { useOrgRealtime } from '@/retained/hooks/useOrgs';
import { ListPane } from '../../frame/list-pane/list-pane';
import { accountNav, activeNavHref, driveSettingsNav, type NavContext, type NavItem } from './settings-nav';
import { navGroupLabelClass, navRowClass } from './settings-nav-class';

const isDesktop = (): boolean =>
  typeof window !== 'undefined' && (window as { electron?: { isDesktop?: boolean } }).electron?.isDesktop === true;

/** The build's and the viewer's gates, as classic's settings index reads them. */
export const navContext = (): NavContext => ({
  isDesktop: isDesktop(),
  showBilling: isBillingEnabled(),
  isNative: isNativeApp(),
  onPrem: isOnPrem(),
  hasOrganizations: false,
});

/** Membership-based account visibility shares the org realtime cache with the retained surfaces. */
export function useAccountNav() {
  const { organizations } = useMyOrganizations();
  useOrgRealtime();
  return accountNav({ ...navContext(), hasOrganizations: organizations.length > 0 });
}

const rows = (items: readonly NavItem[], active: string | null): ReactNode =>
  items.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      prefetch={true}
      className={navRowClass(item.href === active)}
      aria-current={item.href === active ? 'page' : undefined}
    >
      {item.label}
    </Link>
  ));

/** The 260px "Drive settings" pane: the drive's settings in the SPEC's fixed order (IMC-1.11). */
export function DriveSettingsNavPane({ driveId }: { readonly driveId: string }) {
  const pathname = usePathname() ?? '/';
  const drive = useDriveStore((state) => state.drives.find((entry) => entry.id === driveId));
  const access = drive === undefined ? undefined : { role: drive.role ?? (drive.isOwned ? 'OWNER' : 'MEMBER'), home: drive.kind === 'HOME' } as const;
  const items = driveSettingsNav(driveId, navContext(), access);
  return (
    <ListPane section="settings" variant="tree" title="Drive settings">
      <nav aria-label="Drive settings">{rows(items, activeNavHref(items, pathname))}</nav>
    </ListPane>
  );
}

/** The 260px "Account" pane: the account screens grouped You · AI · Plan & data · Connections · Other. */
export function AccountNavPane() {
  const pathname = usePathname() ?? '/';
  const groups = useAccountNav();
  const active = activeNavHref(groups.flatMap((group) => group.items), pathname);
  return (
    <ListPane section="account" variant="tree" title="Account">
      <nav aria-label="Account">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-px pb-2">
            <div className={navGroupLabelClass}>{group.label}</div>
            {rows(group.items, active)}
          </div>
        ))}
      </nav>
    </ListPane>
  );
}

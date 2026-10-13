'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isBillingEnabled, isOnPrem } from '@/retained/lib/deployment-mode';
import { ORGS_ENABLED } from '../orgs-flag';
import { ListPane } from '../../frame/list-pane/list-pane';
import { accountNav, activeNavHref, driveSettingsNav, type NavContext, type NavItem } from './settings-nav';
import { navGroupLabelClass, navRowClass } from './settings-nav-class';

const isDesktop = (): boolean =>
  typeof window !== 'undefined' && (window as { electron?: { isDesktop?: boolean } }).electron?.isDesktop === true;

/** The build's and the viewer's gates, as classic's settings index reads them. */
const navContext = (): NavContext => ({
  isDesktop: isDesktop(),
  showBilling: isBillingEnabled(),
  isNative: false,
  onPrem: isOnPrem(),
  orgs: ORGS_ENABLED,
});

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
  const items = driveSettingsNav(driveId, navContext());
  return (
    <ListPane section="settings" variant="tree" title="Drive settings">
      <nav aria-label="Drive settings">{rows(items, activeNavHref(items, pathname))}</nav>
    </ListPane>
  );
}

/** The 260px "Account" pane: the account screens grouped You · AI · Plan & data · Connections · Other. */
export function AccountNavPane() {
  const pathname = usePathname() ?? '/';
  const groups = accountNav(navContext());
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

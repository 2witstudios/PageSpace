'use client';

// The account overview (C-Account-Index): the viewer's identity, what they have at a glance, and every
// account screen grouped as the nav groups them. Each figure is read from an apps/web route; a figure no
// route answers is left out, never invented.

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { signOut } from '@/lib/auth/sign-out';
import { isBillingEnabled } from '@/retained/lib/deployment-mode';
import { Avatar } from '../../components/avatar/avatar';
import { DRIVES } from '../../frame/drives/drives';
import { accountNav, type NavGroup } from '../settings-nav/settings-nav';
import { navContext } from '../settings-nav/settings-nav-pane';
import { SettingsGroup, SettingsRow, SettingsScreen, SettingsSection } from '../settings-screen/settings-screen';
import {
  ACCOUNT_ME,
  CREDITS,
  SUBSCRIPTION_STATUS,
  accountOf,
  describeAccountRow,
  glanceRows,
  overviewGroups,
  type Account,
  type GlanceRow,
} from './account-overview-model';

export type AccountOverviewViewProps = {
  readonly account: Account | null;
  readonly glance: readonly GlanceRow[];
  readonly groups: readonly NavGroup[];
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
};

/** The overview's markup, given its figures: no requests, so it renders the same in every test. */
export function AccountOverviewView({ account, glance, groups, signingOut, onSignOut }: AccountOverviewViewProps) {
  return (
    <SettingsScreen
      title={account?.name || 'Account'}
      lede={account?.email ?? undefined}
      actions={
        <>
          <Avatar name={account?.name ?? ''} src={account?.image ?? undefined} size="lg" />
          <Link href="/account/profile" className="inline-flex h-8 items-center rounded-lg border border-hairline px-3 text-sm text-ink hover:bg-tint">
            Edit profile
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="inline-flex h-8 items-center rounded-lg border border-hairline px-3 text-sm text-ink hover:bg-tint disabled:opacity-50"
          >
            Sign out
          </button>
        </>
      }
    >
      {glance.length === 0 ? null : (
        <section aria-label="At a glance" className="flex divide-x divide-hairline overflow-hidden rounded-xl border border-hairline">
          {glance.map((row) => (
            <Link key={row.label} href={row.href} className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 hover:bg-tint">
              <span className="text-xs text-ink-muted">{row.label}</span>
              <span className="text-base font-semibold tabular-nums text-ink">{row.value ?? '—'}</span>
            </Link>
          ))}
        </section>
      )}
      {overviewGroups(groups).map((group) => (
        <SettingsSection key={group.label} title={group.label}>
          <SettingsGroup label={group.label}>
            {group.items.map((item) => (
              <Link key={item.href} href={item.href} className="block hover:bg-tint">
                <SettingsRow label={item.label} hint={describeAccountRow(item.href)} />
              </Link>
            ))}
          </SettingsGroup>
        </SettingsSection>
      ))}
    </SettingsScreen>
  );
}

/** The overview with its figures loaded from apps/web; billing rows exist only where billing is on. */
export function AccountOverview() {
  const { data: meBody } = useSWR<unknown>(ACCOUNT_ME);
  const { data: statusBody } = useSWR<unknown>(SUBSCRIPTION_STATUS);
  const { data: creditsBody } = useSWR<unknown>(CREDITS);
  const { data: drivesBody } = useSWR<unknown>(DRIVES);
  const [signingOut, setSigningOut] = useState(false);

  const glance = glanceRows({ billing: isBillingEnabled(), status: statusBody, credits: creditsBody, drives: drivesBody });

  return (
    <AccountOverviewView
      account={accountOf(meBody)}
      glance={glance}
      groups={accountNav(navContext())}
      signingOut={signingOut}
      onSignOut={() => {
        setSigningOut(true);
        void signOut({
          fetch: (input, init) => window.fetch(input, init),
          navigate: (url) => window.location.assign(url),
        });
      }}
    />
  );
}

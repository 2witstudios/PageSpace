import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import type { AccountLink } from '../settings-model/settings-model';
import {
  accountLinkClass,
  accountListClass,
  memberEmailClass,
  memberNameClass,
  memberTextClass,
  settingsClass,
  settingsDetailClass,
  settingsSectionClass,
  settingsTitleClass,
} from '../drive-settings/drive-settings-class';

/*
 * Plain anchors, not next/link: classic's settings live outside imago's
 * basePath, and a full navigation is what leaving for classic is.
 */
const accountLink = (link: AccountLink): ReactNode => (
  <li key={link.id}>
    <a href={link.href} className={accountLinkClass} data-account-link={link.id}>
      <span className={memberTextClass}>
        <span className={memberNameClass}>{link.label}</span>
        <span className={memberEmailClass}>{link.detail}</span>
      </span>
      {renderIcon({ name: 'arrowUpRight', size: 16 })}
    </a>
  </li>
);

/** The account object: the viewer's own settings, which open in Classic PageSpace. */
export function renderAccount({ links }: { readonly links: readonly AccountLink[] }): ReactNode {
  return (
    <div className={settingsClass} data-account="">
      <h1 className={settingsTitleClass}>Account</h1>
      <section className={settingsSectionClass} aria-label="Account settings">
        <p className={settingsDetailClass}>Your account settings open in Classic PageSpace.</p>
        <ul className={accountListClass}>{links.map(accountLink)}</ul>
      </section>
    </div>
  );
}

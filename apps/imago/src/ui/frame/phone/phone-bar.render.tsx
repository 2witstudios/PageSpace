import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { renderSpineCount } from '../rail-button/rail-button.render';
import type { PhoneBarItem } from './phone-bar-model';
import { phoneBarClass, phoneBarItemClass, phoneBarMarkerClass } from './phone-bar-class';

export type PhoneBarRenderProps = {
  readonly items: readonly PhoneBarItem[];
  /** The More item: the account menu, bound by the container. */
  readonly more: ReactNode;
};

/**
 * The phone's bottom bar, in place of the spine: the section links, with aria-current on the
 * active one, then More (the account menu).
 */
export function renderPhoneBar({ items, more }: PhoneBarRenderProps): ReactNode {
  return (
    <nav aria-label="Sections" className={phoneBarClass} data-slot="phone-bar">
      {items.map((entry) => {
        const inner = (
          <>
            {entry.current ? <span className={phoneBarMarkerClass} aria-hidden="true" /> : null}
            {renderIcon({ name: entry.icon, size: 21 })}
            {entry.label}
            {renderSpineCount(entry.unread)}
          </>
        );
        return entry.href === null ? (
          <span key={entry.id} className={phoneBarItemClass(false)} aria-label={entry.name} aria-disabled="true">
            {inner}
          </span>
        ) : (
          <Link
            key={entry.id}
            href={entry.href}
            prefetch={true}
            className={phoneBarItemClass(entry.current)}
            aria-label={entry.name}
            aria-current={entry.current ? 'page' : undefined}
          >
            {inner}
          </Link>
        );
      })}
      {more}
    </nav>
  );
}

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import type { IconName } from '../../components/icon/icon-names';
import type { RailPlace } from '../rail/rail-items';
import { renderIcon } from '../../components/icon/icon.render';
import { renderUnreadCount } from '../../components/unread-count/unread-count.render';
import { railChipClass, railHitClass, railTooltipClass, railUnreadClass } from './rail-button-class';

export type RailButtonRenderProps = {
  readonly icon: IconName;
  readonly label: string;
  /** basePath-relative; null when there is no drive to link into. */
  readonly href: string | null;
  /** Where the viewer is if this is the active item; null otherwise. */
  readonly current: RailPlace | null;
  /** Drawn as the accent count above zero. */
  readonly unread: number;
  /**
   * Void action, present only on the active item while its section's list is
   * hidden: the click reopens the list instead of navigating.
   */
  readonly onReopen?: (() => void) | undefined;
};

/** The label beside the control on hover and focus; the control carries the name. */
export const renderRailTooltip = (label: string): ReactNode => (
  <span className={railTooltipClass} aria-hidden="true">
    {label}
  </span>
);

/** `page` only on the URL the link points at; `true` anywhere inside its section. */
const ariaCurrent: Readonly<Record<RailPlace, 'page' | 'true'>> = { page: 'page', section: 'true' };

/**
 * One rail destination: a 44px control carrying a 38px chip, the active
 * marker, its tooltip and any unread count. Every link prefetches its full
 * route, so a section opens from the cache.
 */
export function renderRailButton(props: RailButtonRenderProps): ReactNode {
  const { icon, label, href, current, unread, onReopen } = props;
  const active = current !== null;
  const name = unread > 0 ? `${label}, ${unread} unread` : label;
  const inner = (
    <>
      <span className={railChipClass(active, href !== null)}>{renderIcon({ name: icon, size: 18 })}</span>
      {renderUnreadCount({ count: unread, className: railUnreadClass })}
      {renderRailTooltip(label)}
    </>
  );

  if (href === null) {
    return (
      <button type="button" className={railHitClass(false)} aria-label={name} disabled>
        {inner}
      </button>
    );
  }

  const reopen =
    onReopen === undefined
      ? undefined
      : (event: MouseEvent) => {
          event.preventDefault();
          onReopen();
        };

  return (
    <Link
      href={href}
      prefetch={true}
      className={railHitClass(true)}
      aria-label={name}
      aria-current={current === null ? undefined : ariaCurrent[current]}
      onClick={reopen}
    >
      {inner}
    </Link>
  );
}

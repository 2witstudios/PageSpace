import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import type { IconName } from '../../components/icon/icon-names';
import type { RailPlace } from '../rail/rail-items';
import { renderIcon } from '../../components/icon/icon.render';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
import {
  railTooltipClass,
  spineCountClass,
  spineMarkerClass,
  spineTileClass,
  type SpineTileSize,
} from './rail-button-class';

export type RailButtonRenderProps = {
  readonly icon: IconName;
  /** Imago's own destination: its orb in place of the icon. */
  readonly imago?: boolean | undefined;
  readonly label: string;
  /** basePath-relative; null when there is no drive to link into. */
  readonly href: string | null;
  /** Where the viewer is if this is the active item; null otherwise. */
  readonly current: RailPlace | null;
  /** Drawn as the amber count above zero. */
  readonly unread: number;
  readonly size?: SpineTileSize;
  /**
   * Void action, present only on the active item while its section's pane is
   * hidden: the click reopens the pane instead of navigating.
   */
  readonly onReopen?: (() => void) | undefined;
};

/** The label beside the control on hover and focus; the control carries the name. */
export const renderRailTooltip = (label: string): ReactNode => (
  <span className={railTooltipClass} aria-hidden="true">
    {label}
  </span>
);

/** The amber count on a spine tile: hidden at zero, "99+" past 99. */
export const renderSpineCount = (count: number): ReactNode =>
  count > 0 ? (
    <span className={spineCountClass} aria-hidden="true">
      {count > 99 ? '99+' : count}
    </span>
  ) : null;

/** `page` only on the URL the link points at; `true` anywhere inside its section. */
const ariaCurrent: Readonly<Record<RailPlace, 'page' | 'true'>> = { page: 'page', section: 'true' };

/**
 * One spine destination: a tile with its icon, the active marker, its tooltip and any unread
 * count. Every link prefetches its full route, so a section opens from the cache.
 */
export function renderRailButton(props: RailButtonRenderProps): ReactNode {
  const { icon, imago = false, label, href, current, unread, onReopen, size = 'small' } = props;
  const active = current !== null;
  const name = unread > 0 ? `${label}, ${unread} unread` : label;
  const inner = (
    <>
      {active ? <span className={spineMarkerClass(size)} aria-hidden="true" /> : null}
      {imago ? <ImagoOrb size="tile" /> : renderIcon({ name: icon, size: size === 'primary' ? 20 : 18 })}
      {renderSpineCount(unread)}
      {renderRailTooltip(label)}
    </>
  );

  if (href === null) {
    return (
      <button type="button" className={spineTileClass(size, false, false)} aria-label={name} disabled>
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
      className={spineTileClass(size, active)}
      aria-label={name}
      aria-current={current === null ? undefined : ariaCurrent[current]}
      onClick={reopen}
    >
      {inner}
    </Link>
  );
}

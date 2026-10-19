import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { accountItemClass, accountMenuClass } from '../avatar-menu/avatar-menu-class';
import {
  spineDividerClass,
  spineListClass,
  spineTileClass,
} from '../rail-button/rail-button-class';
import { renderRailButton, renderRailTooltip } from '../rail-button/rail-button.render';
import type { RailItem, RailItemId, RailPlace, SecondaryItem } from './rail-items';

export type RailRenderProps = {
  readonly items: readonly RailItem[];
  readonly tools: readonly SecondaryItem[];
  /** Behind the More entry at the foot: the housekeeping tools. */
  readonly more: readonly SecondaryItem[];
  readonly settings: RailItem;
  readonly activeId: RailItemId | null;
  /** The active item's own URL is open, or a place inside its section. */
  readonly activeAt: RailPlace;
  readonly unread: Partial<Readonly<Record<RailItemId, number>>>;
  /** The bell: the notifications popover, at the foot (IMC-9.13). */
  readonly bell: ReactNode;
  /** Opens the ⌘K palette. */
  readonly onSearch: () => void;
  /**
   * Void action, present only while the open section's pane is hidden: the active item then
   * reopens it rather than navigating.
   */
  readonly onReopen?: (() => void) | undefined;
  /** Above Search: the drive switcher's tile. */
  readonly brand: ReactNode;
  /** At the foot, below Drive settings: the avatar menu. */
  readonly footer: ReactNode;
};

/**
 * The spine (SPEC v3, C-Files-Doc): the drive tile, Search (⌘K), Chat · Files · Messages ·
 * Tasks, a divider, Calendar · Agents · Workflows · Activity · Members · Trash, then at the
 * foot the bell, Drive settings and the avatar.
 */
export function renderRail(props: RailRenderProps): ReactNode {
  const { activeId, activeAt, unread, onReopen } = props;
  const current = (id: RailItemId) => (id === activeId ? activeAt : null);
  return (
    <>
      {props.brand === null ? null : <div className="mb-2">{props.brand}</div>}
      <button type="button" className={`${spineTileClass('small', false)} mb-2`} aria-label="Search" onClick={props.onSearch}>
        {renderIcon({ name: 'search', size: 18 })}
        {renderRailTooltip('Search  ⌘K')}
      </button>
      <ul className={spineListClass}>
        {props.items.map((entry) => (
          <li key={entry.id}>
            {renderRailButton({
              icon: entry.icon,
              label: entry.label,
              href: entry.href,
              current: current(entry.id),
              unread: unread[entry.id] ?? 0,
              size: 'primary',
              onReopen: entry.id === activeId ? onReopen : undefined,
            })}
          </li>
        ))}
      </ul>
      <span className={spineDividerClass} aria-hidden="true" />
      <ul className={spineListClass}>
        {props.tools.map((entry) => (
          <li key={entry.id}>
            {renderRailButton({
              icon: entry.icon,
              label: entry.label,
              href: entry.href,
              current: current(entry.id),
              unread: unread[entry.id] ?? 0,
              onReopen: entry.id === activeId ? onReopen : undefined,
            })}
          </li>
        ))}
      </ul>
      <div className="flex-1" />
      <ul className={spineListClass}>
        <li className="relative">
          <details>
            <summary
              className={`${spineTileClass('small', props.more.some((entry) => entry.id === activeId))} summary-plain`}
              aria-label="More"
            >
              {renderIcon({ name: 'more', size: 18 })}
              {renderRailTooltip('More')}
            </summary>
            <ul className={accountMenuClass} aria-label="More tools">
              {props.more.map((entry) => (
                <li key={entry.id}>
                  {entry.href === null ? (
                    <span className={accountItemClass} aria-disabled="true">
                      {renderIcon({ name: entry.icon, size: 16 })}
                      {entry.label}
                    </span>
                  ) : (
                    <Link
                      href={entry.href}
                      aria-current={entry.id === activeId ? 'page' : undefined}
                      className={accountItemClass}
                    >
                      {renderIcon({ name: entry.icon, size: 16 })}
                      {entry.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </li>
        <li>{props.bell}</li>
        <li>
          {renderRailButton({
            icon: props.settings.icon,
            label: props.settings.label,
            href: props.settings.href,
            current: current(props.settings.id),
            unread: 0,
            onReopen: props.settings.id === activeId ? onReopen : undefined,
          })}
        </li>
        {props.footer === null ? null : <li className="mt-2">{props.footer}</li>}
      </ul>
    </>
  );
}

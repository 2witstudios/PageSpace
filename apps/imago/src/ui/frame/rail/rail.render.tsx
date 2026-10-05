import type { ReactNode, SyntheticEvent } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import {
  overflowLinkClass,
  overflowMenuClass,
  railChipClass,
  railHitClass,
  railListClass,
  railPinnedClass,
} from '../rail-button/rail-button-class';
import { renderRailButton, renderRailTooltip } from '../rail-button/rail-button.render';
import type { OverflowItem, RailItem, RailItemId } from './rail-items';

export type RailRenderProps = {
  readonly items: readonly RailItem[];
  readonly settings: RailItem;
  readonly activeId: RailItemId | null;
  readonly unread: Partial<Readonly<Record<RailItemId, number>>>;
  /**
   * Void action, present only while the open section's list is hidden: the
   * active item then reopens it rather than navigating.
   */
  readonly onReopen?: (() => void) | undefined;
  /** Classic deep links for the current drive; null with no drive. */
  readonly overflow: readonly OverflowItem[] | null;
  readonly moreOpen: boolean;
  readonly onMoreToggle: (open: boolean) => void;
  /** Below Settings: sign-out, until the avatar menu (IMG-3.4) takes it. */
  readonly footer: ReactNode;
};

const MORE = 'More';

const item = (entry: RailItem, props: RailRenderProps): ReactNode => {
  const active = entry.id === props.activeId;
  return (
    <li key={entry.id}>
      {renderRailButton({
        icon: entry.icon,
        label: entry.label,
        href: entry.href,
        active,
        unread: props.unread[entry.id] ?? 0,
        onReopen: active ? props.onReopen : undefined,
      })}
    </li>
  );
};

const moreChip = (enabled: boolean): ReactNode => (
  <>
    <span className={railChipClass(false, enabled)}>{renderIcon({ name: 'more', size: 18 })}</span>
    {renderRailTooltip(MORE)}
  </>
);

/**
 * The ⋯ overflow: a native disclosure, so it opens from the keyboard and
 * reports its state without script. Its links leave imago for classic, so
 * they are plain anchors: Next's Link would put imago's basePath in front.
 */
const overflow = (props: RailRenderProps): ReactNode => {
  const { overflow: links, moreOpen, onMoreToggle } = props;
  if (links === null) {
    return (
      <li>
        <button type="button" className={railHitClass(false)} aria-label={MORE} disabled>
          {moreChip(false)}
        </button>
      </li>
    );
  }
  return (
    <li>
      <details
        className="relative"
        open={moreOpen}
        onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => onMoreToggle(event.currentTarget.open)}
      >
        <summary className={`${railHitClass(true)} summary-plain`} aria-label={MORE}>
          {moreChip(true)}
        </summary>
        <ul className={overflowMenuClass} aria-label="Open in classic">
          {links.map((link) => (
            <li key={link.id}>
              <a href={link.href} className={overflowLinkClass}>
                {renderIcon({ name: link.icon })}
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
};

/**
 * The frame's only persistent navigation, inside the shell's Primary nav:
 * the sections, the ⋯ overflow below Tasks, and Settings pinned to the foot.
 */
export function renderRail(props: RailRenderProps): ReactNode {
  return (
    <>
      <ul className={railListClass}>
        {props.items.map((entry) => item(entry, props))}
        {overflow(props)}
      </ul>
      <ul className={railPinnedClass}>
        {item(props.settings, props)}
        {props.footer === null ? null : <li>{props.footer}</li>}
      </ul>
    </>
  );
}

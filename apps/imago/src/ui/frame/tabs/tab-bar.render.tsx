import Link from 'next/link';
import type { ReactNode } from 'react';
import type { IconName } from '../../components/icon/icon-names';
import { renderIcon } from '../../components/icon/icon.render';
import { tabBarClass, tabClass, tabCloseClass, tabControlClass, tabLinkClass, tabTitleClass } from './tab-bar-class';

export type TabRenderProps = {
  readonly path: string;
  readonly title: string;
  readonly icon: IconName;
  /** The type hue class (text-type-*), or none for screens. */
  readonly hue: string | null;
  readonly selected: boolean;
  readonly onClose: () => void;
};

/** One tab: its type icon and title as a link, then its close control. */
export function renderTab(props: TabRenderProps): ReactNode {
  const { path, title, icon, hue, selected, onClose } = props;
  return (
    <div role="tab" aria-selected={selected} className={tabClass(selected)} data-tab-path={path}>
      <Link href={path} prefetch={true} className={tabLinkClass}>
        <span className={hue ?? 'text-ink-muted'} aria-hidden="true">
          {renderIcon({ name: icon, size: 14 })}
        </span>
        <span className={tabTitleClass}>{title}</span>
      </Link>
      <button type="button" className={tabCloseClass(selected)} aria-label={`Close ${title}`} title="Close tab" onClick={onClose}>
        {renderIcon({ name: 'close', size: 10 })}
      </button>
    </div>
  );
}

export type TabBarRenderProps = {
  readonly tabs: ReactNode;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onNew: () => void;
};

/**
 * The tab bar (SPEC v3.3): Back and Forward, the open tabs, and New tab. It spans every column
 * at the top of the stage sheet.
 */
export function renderTabBar(props: TabBarRenderProps): ReactNode {
  return (
    <div role="tablist" aria-label="Open pages" data-desktop-drag="" className={tabBarClass}>
      <div className="flex items-center gap-1 pr-2">
        <button type="button" className={tabControlClass} aria-label="Back" title="Back" disabled={!props.canBack} onClick={props.onBack}>
          {renderIcon({ name: 'chevronLeft', size: 15 })}
        </button>
        <button type="button" className={tabControlClass} aria-label="Forward" title="Forward" disabled={!props.canForward} onClick={props.onForward}>
          {renderIcon({ name: 'chevronRight', size: 15 })}
        </button>
      </div>
      {props.tabs}
      <button type="button" className={`${tabControlClass} ml-1`} aria-label="New tab" title="New tab" onClick={props.onNew}>
        {renderIcon({ name: 'plus', size: 14 })}
      </button>
      <div className="flex-1" />
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { paneHeaderClass } from '@/ui/frame/pane/pane-class';
import { headControlClass } from '@/ui/frame/controls/controls-class';
import { useSettingsSubnavStore } from './settings-subnav-store';

/** One category row of a settings sub-nav: the key it selects, its title and its one-line copy. */
export type SettingsSubnavItem<Key extends string> = {
  readonly key: Key;
  readonly title: string;
  readonly description: string;
};

export type SettingsSubnavProps<Key extends string> = {
  /** The nav's accessible name: "Agent settings", "Canvas settings"… */
  readonly navLabel: string;
  /** The text in the nav's 48px head, and in the area head once the nav is collapsed. */
  readonly heading: string;
  readonly items: readonly SettingsSubnavItem<Key>[];
  readonly selected: Key;
  readonly onSelect: (key: Key) => void;
  /** The selected category's form, drawn to the right of the nav. */
  readonly children: ReactNode;
};

const rowClass = (current: boolean): string =>
  `flex w-full cursor-pointer flex-col gap-1 rounded-md border-0 px-2.5 py-2 text-left text-sm ${
    current ? 'bg-accent-soft text-accent-deep' : 'bg-transparent text-ink hover:bg-fill'
  }`;

/**
 * The shared in-middle settings sub-nav (IMC-3.12): a persistent category nav on the left and the
 * selected category's form on the right. "Close settings menu" collapses the nav to a "Show
 * settings menu" button at the start of the area head; that state lives in the settings sub-nav
 * store, so every settings area (agent, canvas) opens and closes together.
 */
export function SettingsSubnav<Key extends string>({
  navLabel,
  heading,
  items,
  selected,
  onSelect,
  children,
}: SettingsSubnavProps<Key>) {
  const open = useSettingsSubnavStore((state) => state.open);
  const setOpen = useSettingsSubnavStore((state) => state.setOpen);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      {open && (
        <nav aria-label={navLabel} className="flex min-h-0 w-tree-pane flex-none flex-col border-r border-hairline">
          <div className={paneHeaderClass}>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{heading}</span>
            <button
              type="button"
              aria-label="Close settings menu"
              title="Close settings menu"
              onClick={() => setOpen(false)}
              className={headControlClass}
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
            {items.map((item) => {
              const current = item.key === selected;
              return (
                <button
                  key={item.key}
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onSelect(item.key)}
                  className={rowClass(current)}
                >
                  <span className="font-medium">{item.title}</span>
                  <span className="text-xs text-ink-muted">{item.description}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!open && (
          <div className={paneHeaderClass}>
            <button
              type="button"
              aria-label="Show settings menu"
              title="Show settings menu"
              onClick={() => setOpen(true)}
              className={headControlClass}
            >
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{heading}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

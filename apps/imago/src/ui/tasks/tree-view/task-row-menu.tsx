'use client';

// A task row's ⋯ menu: open the task, move it a place up or down among its
// siblings (the keyboard's way to reorder), or delete it after a second,
// deliberate choice. Built on Radix's menu for focus, typeahead and Escape.

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Icon } from '../../components/icon/icon';
import {
  treeMenuClass,
  treeMenuDangerClass,
  treeMenuItemClass,
  treeMenuSeparatorClass,
  treeMenuTriggerClass,
} from './tree-view-class';

export type TaskRowMenuProps = {
  readonly title: string;
  /** Where the task's detail opens. */
  readonly href?: string;
  /** Null at the top (or bottom) of its list: that move is offered but disabled. */
  readonly moveUp: (() => void) | null;
  readonly moveDown: (() => void) | null;
  readonly remove: () => void;
};

export function TaskRowMenu({ title, href, moveUp, moveDown, remove }: TaskRowMenuProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  return (
    <Menu.Root onOpenChange={(open) => (open ? null : setConfirming(false))}>
      <Menu.Trigger aria-label={`Actions for ${title}`} className={treeMenuTriggerClass}>
        <Icon name="more" size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={4} className={treeMenuClass} aria-label={`Actions for ${title}`}>
          {href === undefined ? null : (
            <Menu.Item asChild className={treeMenuItemClass}>
              <Link href={href} prefetch>
                <Icon name="arrowUpRight" size={14} />
                Open
              </Link>
            </Menu.Item>
          )}
          <Menu.Item className={treeMenuItemClass} disabled={moveUp === null} onSelect={() => moveUp?.()}>
            Move up
          </Menu.Item>
          <Menu.Item className={treeMenuItemClass} disabled={moveDown === null} onSelect={() => moveDown?.()}>
            Move down
          </Menu.Item>
          <Menu.Separator className={treeMenuSeparatorClass} />
          {confirming ? (
            <Menu.Item className={treeMenuDangerClass} onSelect={remove}>
              <Icon name="trash" size={14} />
              Delete with its subtasks
            </Menu.Item>
          ) : (
            <Menu.Item
              className={treeMenuDangerClass}
              onSelect={(event) => {
                // The first choice only asks again; the menu stays open for the answer.
                event.preventDefault();
                setConfirming(true);
              }}
            >
              <Icon name="trash" size={14} />
              Delete…
            </Menu.Item>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

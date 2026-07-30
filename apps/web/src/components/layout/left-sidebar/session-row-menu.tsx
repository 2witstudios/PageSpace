'use client';

import { Fragment, type ComponentType, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTouchDevice } from '@/hooks/useTouchDevice';
import { cn } from '@/lib/utils';

export interface RowMenuItem {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
  destructive?: boolean;
  /** Renders a separator immediately before this item — the item list stays flat. */
  separatorBefore?: boolean;
}

/**
 * The one place a row's menu items become JSX — used for BOTH the
 * right-click content and the 3-dots dropdown, so the two surfaces can never
 * drift into different item sets (the wart in `TaskTableRow`, which
 * hand-duplicates its item list between `DropdownMenuContent` and
 * `ContextMenuContent`).
 */
function renderRowMenuItems(
  items: RowMenuItem[],
  ItemComponent: ComponentType<{
    onSelect: (event: Event) => void;
    className?: string;
    children?: ReactNode;
  }>,
  SeparatorComponent: ComponentType,
) {
  return items.map((item) => (
    <Fragment key={item.label}>
      {item.separatorBefore && <SeparatorComponent />}
      <ItemComponent
        onSelect={item.onSelect}
        className={cn(item.destructive && 'text-red-500 focus:text-red-500')}
      >
        <item.icon className="mr-2 size-3.5" aria-hidden="true" />
        {item.label}
      </ItemComponent>
    </Fragment>
  ));
}

/**
 * Both-in-one row actions: right-click anywhere on `children` opens a context
 * menu, and a `MoreHorizontal` button (auto-revealed on touch, hover-revealed
 * on desktop via the row's own `group`) opens the same items as a dropdown.
 * `className` lands on the wrapping row element — the row's own layout
 * classes belong here, not on `children`.
 */
export function RowMenu({
  children,
  items,
  menuLabel,
  className,
}: {
  children: ReactNode;
  items: RowMenuItem[];
  menuLabel: string;
  className?: string;
}) {
  const isTouchDevice = useTouchDevice();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn('group flex w-full items-center', className)}>
          {children}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={menuLabel}
                className={cn(
                  'h-5 w-5 shrink-0 text-muted-foreground transition-opacity hover:text-foreground',
                  isTouchDevice ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                )}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {renderRowMenuItems(items, DropdownMenuItem, DropdownMenuSeparator)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{renderRowMenuItems(items, ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
    </ContextMenu>
  );
}

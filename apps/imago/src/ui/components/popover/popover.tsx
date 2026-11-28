'use client';

import { useState, type ReactElement, type ReactNode } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { popoverContentClass, type PopoverWidth } from './popover-class';

export type PopoverProps = {
  /** The control that opens it: one button element, given the popover's state. */
  readonly trigger: ReactElement;
  /** The dialog's accessible name. */
  readonly label: string;
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: PopoverWidth;
  /** What it holds, given the void action that closes it. */
  readonly children: (close: () => void) => ReactNode;
};

/**
 * A v3 popover on Radix: anchored to its trigger, portalled above the panes,
 * focus moved in and returned, and closed by Escape or a click outside.
 */
export function Popover({ trigger, label, align = 'start', width = 'popover', children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          aria-label={label}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={popoverContentClass(width)}
        >
          {open ? children(() => setOpen(false)) : null}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

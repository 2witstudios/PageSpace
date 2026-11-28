'use client';

import type { ReactElement, ReactNode } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { renderIcon } from '../icon/icon.render';
import { menuCheckClass, menuItemClass, popoverContentClass, type PopoverWidth } from './popover-class';

export type MenuOption = {
  readonly value: string;
  readonly label: string;
  /** Drawn before the label: a status dot, a priority glyph. */
  readonly leading?: ReactNode;
};

export type ChoiceMenuProps = {
  /** The control that opens it: one button element. */
  readonly trigger: ReactElement;
  /** The menu's accessible name. */
  readonly label: string;
  readonly options: readonly MenuOption[];
  /** The chosen option's value: it carries the check. */
  readonly value: string;
  /** Void action: called with another option's value; choosing the current one only closes the menu. */
  readonly choose: (value: string) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: PopoverWidth;
};

/**
 * A menu of one choice on Radix's dropdown: arrow keys and typeahead move
 * through the options, Enter or a click chooses and closes, Escape closes.
 */
export function ChoiceMenu({ trigger, label, options, value, choose, align = 'start', width = 'menu' }: ChoiceMenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          aria-label={label}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={popoverContentClass(width)}
        >
          <RadixMenu.RadioGroup
            value={value}
            onValueChange={(next) => {
              if (next !== value) choose(next);
            }}
          >
            {options.map((option) => (
              <RadixMenu.RadioItem key={option.value} value={option.value} className={menuItemClass}>
                {option.leading}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <RadixMenu.ItemIndicator className={menuCheckClass}>{renderIcon({ name: 'check', size: 14 })}</RadixMenu.ItemIndicator>
              </RadixMenu.RadioItem>
            ))}
          </RadixMenu.RadioGroup>
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

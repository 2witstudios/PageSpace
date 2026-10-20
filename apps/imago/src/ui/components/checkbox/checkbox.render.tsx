import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { checkboxClass } from './checkbox-class';

export type CheckboxRenderProps = {
  readonly checked: boolean;
  /** Required accessible name: what ticking it does. */
  readonly label: string;
  /** Void action: ticks it, or clears it; absent, the box is read-only (disabled). */
  readonly toggle?: () => void;
};

/**
 * A native button with the checkbox role: it sits in the tab order and the
 * platform turns Space and Enter into the click that toggles it. Without
 * a toggle it is disabled: it still reads as ticked or not, but takes no
 * click and leaves the tab order.
 */
export function renderCheckbox({ checked, label, toggle }: CheckboxRenderProps): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={toggle === undefined}
      className={checkboxClass(checked, toggle === undefined)}
      onClick={toggle}
    >
      <Check size={12} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

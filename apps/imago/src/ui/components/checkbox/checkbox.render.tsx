import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { checkboxClass } from './checkbox-class';

export type CheckboxRenderProps = {
  readonly checked: boolean;
  /** Required accessible name: what ticking it does. */
  readonly label: string;
  /** Void action: ticks it, or clears it. */
  readonly toggle: () => void;
};

/**
 * A native button with the checkbox role: it sits in the tab order and the
 * platform turns Space and Enter into the click that toggles it.
 */
export function renderCheckbox({ checked, label, toggle }: CheckboxRenderProps): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={checkboxClass(checked)}
      onClick={toggle}
    >
      <Check size={12} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

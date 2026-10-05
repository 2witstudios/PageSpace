import type { KeyboardEvent, ReactNode } from 'react';
import { segmentClass, segmentCountClass, segmentedControlClass } from './segmented-control-class';

export type Segment<T extends string> = {
  readonly value: T;
  readonly label: string;
  /** Shown after the label, as in "Mine · 7". */
  readonly count?: number;
};

export type SegmentedControlRenderProps<T extends string> = {
  /** The group's accessible name, such as "View" or "Filter". */
  readonly label: string;
  readonly segments: readonly Segment<T>[];
  readonly value: T;
  /** Void action: picks a segment. */
  readonly select: (value: T) => void;
};

/**
 * The segment a radiogroup key moves to (WAI-ARIA radio pattern): the
 * arrows step and wrap, Home and End jump to the ends. `current` is the
 * radio that has focus; one that matches no segment is read as the first,
 * which is where the tab stop puts focus when nothing is checked. Undefined
 * for a key the group does not own.
 */
export const segmentAfterKey = <T extends string>(
  values: readonly T[],
  current: T,
  key: string,
): T | undefined => {
  if (values.length === 0) return undefined;
  const index = Math.max(0, values.indexOf(current));
  const last = values.length - 1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return values[index === last ? 0 : index + 1];
    case 'ArrowLeft':
    case 'ArrowUp':
      return values[index === 0 ? last : index - 1];
    case 'Home':
      return values[0];
    case 'End':
      return values[last];
    default:
      return undefined;
  }
};

/**
 * PageSpace's segmented switch as a radiogroup: one checked radio on a quiet
 * track. The checked radio is the group's single tab stop (the first one when
 * nothing is checked); the arrows, Home and End move focus and selection
 * together. The view switcher (Focus, Tree, Board) and the task filters use it.
 */
export function renderSegmentedControl<T extends string>({
  label,
  segments,
  value,
  select,
}: SegmentedControlRenderProps<T>): ReactNode {
  const values = segments.map((segment) => segment.value);
  const tabStop = values.includes(value) ? value : values[0];

  // Arrows step from the radio that has focus, not from `value`: with
  // nothing checked, or a parent that ignores `select`, they differ.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const focused = values[radios.findIndex((radio) => radio === event.target)] ?? tabStop ?? value;
    const next = segmentAfterKey(values, focused, event.key);
    if (next === undefined) return;
    event.preventDefault();
    radios[values.indexOf(next)]?.focus();
    select(next);
  };

  return (
    <div role="radiogroup" aria-label={label} className={segmentedControlClass} onKeyDown={onKeyDown}>
      {segments.map((segment) => (
        <button
          key={segment.value}
          type="button"
          role="radio"
          aria-checked={segment.value === value}
          tabIndex={segment.value === tabStop ? 0 : -1}
          className={segmentClass(segment.value === value)}
          onClick={() => select(segment.value)}
        >
          {segment.label}
          {segment.count === undefined ? null : (
            <span className={segmentCountClass}>{` · ${segment.count}`}</span>
          )}
        </button>
      ))}
    </div>
  );
}

import type { ReactNode } from 'react';
import { TEXT_SIZES, type TextSize } from '@/lib/text-size/text-size-preference';
import { textSizeOptionClass, textSizeSwitcherClass } from './text-size-switcher-class';

const labels: Readonly<Record<TextSize, string>> = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
  larger: 'Larger',
};

export type TextSizeSwitcherRenderProps = {
  readonly size: TextSize;
  /** Void action: persists and applies the chosen size. */
  readonly selectSize: (size: TextSize) => void;
};

/** Four "A"s, each a little larger than the last; the pressed one is the size the page is at. */
export function renderTextSizeSwitcher({ size, selectSize }: TextSizeSwitcherRenderProps): ReactNode {
  return (
    <div role="group" aria-label="Text size" className={textSizeSwitcherClass}>
      {TEXT_SIZES.map((option) => {
        const pressed = option === size;
        return (
          <button
            key={option}
            type="button"
            aria-label={`Text size: ${labels[option]}`}
            aria-pressed={pressed}
            className={textSizeOptionClass(option, pressed)}
            onClick={() => selectSize(option)}
          >
            <span aria-hidden="true">A</span>
          </button>
        );
      })}
    </div>
  );
}

import type { KeyboardEvent, ReactNode } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import type { ThemePreference } from '@/lib/theme/theme-preference';
import { optionClass, switcherClass } from './theme-switcher-class';

const options = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const satisfies readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: LucideIcon;
}[];

const steps: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Radio-group arrow keys: move and select, wrapping at either end. */
export const preferenceForKey = (
  current: ThemePreference,
  key: string,
): ThemePreference | undefined => {
  const step = steps[key];
  if (step === undefined) return undefined;
  const index = options.findIndex((option) => option.value === current);
  return options[(index + step + options.length) % options.length]?.value;
};

export type ThemeSwitcherRenderProps = {
  readonly preference: ThemePreference;
  /** Void action: persists and applies the chosen preference. */
  readonly selectPreference: (preference: ThemePreference) => void;
};

export function renderThemeSwitcher({
  preference,
  selectPreference,
}: ThemeSwitcherRenderProps): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = preferenceForKey(preference, event.key);
    if (next === undefined) return;
    event.preventDefault();
    selectPreference(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>(`[data-preference="${next}"]`)
      ?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Theme" className={switcherClass}>
      {options.map(({ value, label, icon: OptionIcon }) => {
        const checked = value === preference;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-preference={value}
            className={optionClass(checked)}
            onClick={() => selectPreference(value)}
            onKeyDown={onKeyDown}
          >
            {/* lucide at the house stroke and size (DEC-8). */}
            <OptionIcon size={16} strokeWidth={1.5} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

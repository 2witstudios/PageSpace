import { renderToString } from 'react-dom/server';
import {
  Children,
  createElement as h,
  isValidElement,
  type ReactNode,
} from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { preferenceForKey, renderThemeSwitcher } from './theme-switcher.render';
import type { ThemePreference } from '@/lib/theme/theme-preference';

type RadioProps = {
  readonly children?: ReactNode;
  readonly role?: string;
  readonly onClick?: () => void;
  readonly onKeyDown?: (event: unknown) => void;
};

const radiosOf = (node: ReactNode): readonly RadioProps[] => {
  if (!isValidElement<RadioProps>(node)) return [];
  if (node.props.role === 'radio') return [node.props];
  return Children.toArray(node.props.children).flatMap(radiosOf);
};

/** Parses each rendered radio's label, checked state and tab stop. */
const radiosIn = (html: string) =>
  [
    ...html.matchAll(/<button([^>]*)>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g),
  ].map(([, attributes = '', label]) => ({
    label,
    checked: /aria-checked="true"/.test(attributes),
    tabIndex: /tabindex="(-?\d)"/i.exec(attributes)?.[1],
  }));

const render = (preference: ThemePreference) =>
  renderToString(
    h(renderThemeSwitcher, { preference, selectPreference: () => {} }),
  );

describe('renderThemeSwitcher', () => {
  test('a labelled radio group with the preference checked', () => {
    const html = render('dark');

    assert({
      given: 'the dark preference',
      should: 'offer Light, Dark and System, check Dark, and keep one tab stop',
      actual: {
        group: html.includes('role="radiogroup" aria-label="Theme"'),
        radios: radiosIn(html),
      },
      expected: {
        group: true,
        radios: [
          { label: 'Light', checked: false, tabIndex: '-1' },
          { label: 'Dark', checked: true, tabIndex: '0' },
          { label: 'System', checked: false, tabIndex: '-1' },
        ],
      },
    });
  });

  test('each preference checks only its own radio', () => {
    assert({
      given: 'each preference',
      should: 'render exactly that radio checked',
      actual: (['light', 'dark', 'system'] as const).map((preference) =>
        radiosIn(render(preference))
          .filter((radio) => radio.checked)
          .map((radio) => radio.label),
      ),
      expected: [['Light'], ['Dark'], ['System']],
    });
  });

  test('a click selects that preference', () => {
    const chosen: ThemePreference[] = [];
    const radios = radiosOf(
      renderThemeSwitcher({
        preference: 'system',
        selectPreference: (preference) => chosen.push(preference),
      }),
    );
    for (const radio of radios) radio.onClick?.();

    assert({
      given: 'a click on each radio',
      should: 'select each preference in order',
      actual: chosen,
      expected: ['light', 'dark', 'system'],
    });
  });

  test('arrow keys move selection and focus', () => {
    const chosen: ThemePreference[] = [];
    const focused: string[] = [];
    let prevented = 0;
    const [light] = radiosOf(
      renderThemeSwitcher({
        preference: 'light',
        selectPreference: (preference) => chosen.push(preference),
      }),
    );
    const press = (key: string) =>
      light?.onKeyDown?.({
        key,
        preventDefault: () => {
          prevented += 1;
        },
        currentTarget: {
          parentElement: {
            querySelector: (selector: string) => ({
              focus: () => focused.push(selector),
            }),
          },
        },
      });
    press('ArrowRight');
    press('Tab');

    assert({
      given: 'ArrowRight then Tab on the checked Light radio',
      should: 'select and focus Dark, and leave Tab to the browser',
      actual: { chosen, focused, prevented },
      expected: {
        chosen: ['dark'],
        focused: ['[data-preference="dark"]'],
        prevented: 1,
      },
    });
  });
});

describe('preferenceForKey', () => {
  test('steps through the options and wraps at both ends', () => {
    assert({
      given: 'arrow keys from each end and a non-arrow key',
      should: 'step with wrap-around and ignore other keys',
      actual: [
        preferenceForKey('light', 'ArrowLeft'),
        preferenceForKey('system', 'ArrowDown'),
        preferenceForKey('light', 'ArrowUp'),
        preferenceForKey('dark', 'ArrowRight'),
        preferenceForKey('dark', 'Enter'),
      ],
      expected: ['system', 'light', 'system', 'system', undefined],
    });
  });
});

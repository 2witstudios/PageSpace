import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { renderAvatarMenu, type AvatarMenuRenderProps } from './avatar-menu.render';

const props = (overrides: Partial<AvatarMenuRenderProps> = {}): AvatarMenuRenderProps => ({
  name: 'Ada Lovelace',
  image: null,
  open: true,
  onToggle: () => {},
  onPick: () => {},
  theme: <div role="radiogroup" aria-label="Theme" />,
  onSignOut: () => {},
  signingOut: false,
  ...overrides,
});

const markup = (overrides: Partial<AvatarMenuRenderProps> = {}) => renderToStaticMarkup(renderAvatarMenu(props(overrides)));

/** The menu's actions in order: links by href, the theme group and buttons by text. */
const actions = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>|<div role="radiogroup" aria-label="(Theme)"|<button\b[^>]*>([^<]*)<\/button>/g)].map(
    ([, href, text, theme, button]) => (theme ?? button ?? `${text} → ${href}`),
  );

describe('renderAvatarMenu()', () => {
  test('the account actions', () => {
    const html = markup();

    assert({
      given: 'the menu open for Ada Lovelace',
      should: 'offer Account, the theme switcher, Classic PageSpace (→ /dashboard) and Sign out, in that order',
      actual: actions(html),
      expected: ['Account → /account', 'Theme', 'Classic PageSpace → /dashboard', 'Sign out'],
    });

    assert({
      given: 'the menu open for Ada Lovelace',
      should: 'name the avatar control and show who is signed in',
      actual: [/<summary[^>]*aria-label="Account menu"/.test(html), html.includes('>Ada Lovelace<'), html.includes('>AL<')],
      expected: [true, true, true],
    });
  });

  test('signing out', () => {
    let signedOut = 0;
    const button = findElement<{ onClick?: () => void; disabled?: boolean }>(
      renderAvatarMenu(props({ onSignOut: () => (signedOut += 1) })),
      (element) => element.type === 'button',
    );
    button?.props.onClick?.();

    assert({
      given: 'Sign out pressed, then the menu while signing out',
      should: 'call the sign-out action once, then disable the button',
      actual: [signedOut, /<button[^>]*disabled=""[^>]*>Sign out/.test(markup({ signingOut: true }))],
      expected: [1, true],
    });
  });

  test('before the profile loads', () => {
    assert({
      given: 'no name yet',
      should: 'keep the menu and its actions, with no name line',
      actual: [actions(markup({ name: null })).length, markup({ name: null }).includes('data-account-name')],
      expected: [4, false],
    });
  });
});

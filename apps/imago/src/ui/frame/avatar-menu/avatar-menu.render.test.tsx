import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { renderAvatarMenu, type AvatarMenuRenderProps } from './avatar-menu.render';
import type { CreditsCard } from './avatar-menu-model';

const card: CreditsCard = { plan: 'Pro', resets: 'Nov 3', left: 612, allowance: 900, percent: 68, bonus: 1000, reserved: 14 };

const props = (overrides: Partial<AvatarMenuRenderProps> = {}): AvatarMenuRenderProps => ({
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  image: null,
  open: true,
  onToggle: () => {},
  onPick: () => {},
  theme: <div role="radiogroup" aria-label="Theme" />,
  onSignOut: () => {},
  signingOut: false,
  credits: card,
  onFeedback: () => {},
  verifyEmail: null,
  ...overrides,
});

const markup = (overrides: Partial<AvatarMenuRenderProps> = {}) => renderToStaticMarkup(renderAvatarMenu(props(overrides)));

/** The menu's rows in order: links by href, the theme group and buttons by text. */
const rows = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<div role="radiogroup" aria-label="(Theme)"|<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(
    ([, href, anchor, theme, button]) => (theme ?? (button ? button.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : `${anchor.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()} → ${href}`)),
  );

describe('renderAvatarMenu()', () => {
  test('the account rows, in the board order', () => {
    assert({
      given: 'the menu open for Ada Lovelace with billing on',
      should: 'offer Account, Personalization, Usage, Billing (Pro), Settings, Feedback, the theme, Classic PageSpace and Log out, in that order',
      actual: rows(markup()),
      expected: [
        'Buy credits → /account/usage',
        'Account → /account/profile',
        'Personalization → /account/personalization',
        'Usage 612 / 900 → /account/usage',
        'Billing (Pro) → /account/billing',
        'Settings → /account',
        'Feedback',
        'Theme',
        'Classic PageSpace → /dashboard',
        'Log out',
      ],
    });
  });

  test('the name, the email and the credits card', () => {
    const html = markup();

    assert({
      given: 'the menu open for Ada Lovelace with a credit balance',
      should: 'name the avatar control, show the name and email, and the card with the figures',
      actual: [
        /<summary[^>]*aria-label="Account menu"/.test(html),
        html.includes('>Ada Lovelace<'),
        html.includes('ada@example.com'),
        html.includes('Pro · resets Nov 3'),
        html.includes('612 <span'),
        html.includes('/ 900 credits'),
        html.includes('+1,000 bonus credits from top-ups'),
        html.includes('~14 reserved on in-flight calls'),
        /role="progressbar"[^>]*aria-valuenow="68"/.test(html),
      ],
      expected: [true, true, true, true, true, true, true, true, true],
    });
  });

  test('no Billing row and no card without billing', () => {
    const html = markup({ credits: null });

    assert({
      given: 'billing off or the balance not loaded',
      should: 'leave out the card, the Billing row and the Usage figure',
      actual: [html.includes('Your credits'), html.includes('Billing'), html.includes('612 / 900'), rows(html).includes('Usage → /account/usage')],
      expected: [false, false, false, true],
    });
  });

  test('the Verify Email row first while the email is unverified', () => {
    const html = markup({ verifyEmail: { onVerify: () => {} } });

    assert({
      given: 'an unverified email',
      should: 'put a Verify Email row with an Unverified tag at the top of the menu',
      actual: [rows(html)[0], html.includes('>Unverified<')],
      expected: ['Verify Email Unverified', true],
    });
  });

  test('no organizations group yet, and the way back to classic PageSpace', () => {
    const html = markup();

    assert({
      given: 'the menu for an account with no organization rows yet, during the rollout',
      should: 'leave out the Organizations group and keep the Classic PageSpace link',
      actual: [html.includes('Organizations'), html.includes('Classic PageSpace')],
      expected: [false, true],
    });
  });

  test('before the profile loads', () => {
    const html = markup({ name: null, email: null });

    assert({
      given: 'no name yet',
      should: 'keep the menu and its rows, with no name line',
      actual: [html.includes('data-account-name'), rows(html).length],
      expected: [false, 10],
    });
  });

  test('Log out is disabled while signing out', () => {
    assert({
      given: 'Log out pressed, so the menu is signing out',
      should: 'disable the Log out button',
      actual: /<button[^>]*disabled=""[^>]*>\s*Log out/.test(markup({ signingOut: true })),
      expected: true,
    });
  });

  test('picking Feedback runs the feedback action', () => {
    let opened = 0;
    let picked = 0;
    const button = findElement<{ onClick?: () => void }>(
      renderAvatarMenu(props({ onFeedback: () => (opened += 1), onPick: () => (picked += 1) })),
      (element) => element.type === 'button' && element.props.children === 'Feedback',
    );
    button?.props.onClick?.();

    assert({
      given: 'the Feedback row pressed',
      should: 'close the menu and open the feedback dialog once',
      actual: [opened, picked],
      expected: [1, 1],
    });
  });
});

describe('avatar menu without optional account details', () => {
  test('a name without an email shows no email line', () => {
    const html = markup({ email: null });
    assert({
      given: 'a profile with a name but no email',
      should: 'show the name and no email',
      actual: [html.includes('Ada Lovelace'), html.includes('ada@example.com')],
      expected: [true, false],
    });
  });

  test('a plan with no reset date shows just the plan', () => {
    const html = markup({ credits: { ...card, resets: null } });
    assert({
      given: 'credits on a plan that does not reset',
      should: 'name the plan without a resets note',
      actual: [html.includes('Pro</span>'), html.includes('resets')],
      expected: [true, false],
    });
  });

  test('credits with no plan show no plan line and a bare Billing row', () => {
    const html = markup({ credits: { ...card, plan: null, resets: null } });
    assert({
      given: 'credits with no plan name',
      should: 'label the billing row "Billing" with no plan in brackets',
      actual: [html.includes('Billing ('), rows(html).some((row) => row.startsWith('Billing →'))],
      expected: [false, true],
    });
  });
});

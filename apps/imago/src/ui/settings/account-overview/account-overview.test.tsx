// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { accountNav, type NavContext } from '../settings-nav/settings-nav';
import { AccountOverviewView } from './account-overview';
import { overviewGroups } from './account-overview-model';

afterEach(unmountAll);

const cloud: NavContext = { isDesktop: false, showBilling: true, isNative: false, onPrem: false, orgs: false };

const view = (overrides: Partial<Parameters<typeof AccountOverviewView>[0]> = {}) =>
  mount(
    <AccountOverviewView
      account={{ name: 'Jono', email: 'jono@example.com', image: null }}
      glance={[
        { label: 'Plan', value: 'Pro', href: '/account/plan' },
        { label: 'Your credits', value: '612 credits', href: '/account/usage' },
        { label: 'Drives', value: '3', href: '/account/drives' },
      ]}
      groups={overviewGroups(accountNav(cloud))}
      signingOut={false}
      onSignOut={() => {}}
      {...overrides}
    />,
  );

describe('AccountOverviewView', () => {
  test('the identity block: one h1 for the name, the email as the lede, Edit profile and Sign out', () => {
    const container = view();
    assert({
      given: 'a loaded account',
      should: 'show the name as the h1, the email, an Edit profile link to the profile route, and Sign out',
      actual: {
        h1: container.querySelector('h1')?.textContent,
        lede: container.querySelector('header p')?.textContent,
        edit: container.querySelector('a[href="/account/profile"]')?.textContent,
        signOut: [...container.querySelectorAll('button')].map((button) => button.textContent),
        memberSince: container.textContent?.includes('member since'),
      },
      expected: {
        h1: 'Jono',
        lede: 'jono@example.com',
        edit: 'Edit profile',
        signOut: ['Sign out'],
        memberSince: false,
      },
    });
  });

  test('At a glance shows the figures it was given, as links', () => {
    const container = view();
    assert({
      given: 'a plan, credits and a drive count',
      should: 'render each as a labelled link row, in order',
      actual: [...container.querySelectorAll('section[aria-label="At a glance"] a')].map((link) => [
        link.querySelector('span')?.textContent,
        link.querySelector('span:last-child')?.textContent,
      ]),
      expected: [
        ['Plan', 'Pro'],
        ['Your credits', '612 credits'],
        ['Drives', '3'],
      ],
    });
  });

  test('a figure still loading reads as a dash, and billing-off rows are simply absent', () => {
    const container = view({
      glance: [{ label: 'Drives', value: null, href: '/account/drives' }],
    });
    assert({
      given: 'only the drive count, still loading',
      should: 'show a dash and no Plan or credits row',
      actual: container.querySelector('section[aria-label="At a glance"]')?.textContent,
      expected: 'Drives—',
    });
  });

  test('every nav group is listed with its screens and their descriptions', () => {
    const container = view();
    assert({
      given: 'the cloud account nav',
      should: 'list the groups as flat sections, each row with its description',
      actual: {
        groups: [...container.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label')),
        profile: container.querySelector('a[href="/account/profile"][class*="block"]')?.textContent,
      },
      expected: {
        groups: ['You', 'AI', 'Plan & data', 'Connections', 'Other'],
        profile: 'ProfileName, sign-in, passkeys and devices',
      },
    });
  });

  test('Sign out calls back once', () => {
    const onSignOut = vi.fn();
    const container = view({ onSignOut });
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Sign out');
    if (!button) throw new Error('no Sign out button');
    click(button);
    assert({
      given: 'the Sign out button',
      should: 'start sign-out once',
      actual: onSignOut.mock.calls.length,
      expected: 1,
    });
  });
});

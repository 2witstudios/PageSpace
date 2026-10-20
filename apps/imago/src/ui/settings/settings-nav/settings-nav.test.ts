import { describe, test, expect } from 'vitest';
import { assert } from 'riteway/vitest';
import { accountNav, activeNavHref, driveSettingsNav, type NavContext } from './settings-nav';

const cloud: NavContext = { isDesktop: false, showBilling: true, isNative: false, onPrem: false, hasOrganizations: false };
const labels = (groups: ReturnType<typeof accountNav>) => groups.map((group) => [group.label, group.items.map((item) => item.label)]);

describe('driveSettingsNav() (IMC-1.11)', () => {
  test('the viewer\'s access gates the rows (IMC-7.10)', () => {
    const labels = (access: Parameters<typeof driveSettingsNav>[2]) => driveSettingsNav('d1', cloud, access).map((item) => item.label);
    assert({
      given: 'a plain member, an admin, the owner of a Home drive and the owner of a shared drive',
      should: 'show a member Overview, Wallet and Commands; hide Danger zone from admins and on a Home drive',
      actual: [
        labels({ role: 'MEMBER', home: false }),
        labels({ role: 'ADMIN', home: false }).includes('Danger zone'),
        labels({ role: 'OWNER', home: true }).includes('Danger zone'),
        labels({ role: 'OWNER', home: false }).includes('Danger zone'),
      ],
      expected: [['Overview', 'Wallet', 'Commands'], false, false, true],
    });
  });

  test('SPEC order', () => {
    assert({
      given: 'a cloud drive',
      should: 'list Overview through Danger zone in the SPEC’s fixed order',
      actual: driveSettingsNav('d1', { ...cloud, hasOrganizations: true }).map((item) => [item.label, item.href]),
      expected: [
        ['Overview', '/d1/settings'],
        ['General', '/d1/settings/general'],
        ['Members & roles', '/d1/settings/roles'],
        ['Wallet', '/d1/settings/wallet'],
        ['Integrations', '/d1/settings/integrations'],
        ['Commands', '/d1/settings/commands'],
        ['Context', '/d1/settings/context'],
        ['Backups', '/d1/settings/backups'],
        ['Domains', '/d1/settings/domains'],
        ['Danger zone', '/d1/settings/danger'],
      ],
    });
  });

  test('gates', () => {
    assert({
      given: 'an on-prem build',
      should: 'omit integrations and retain its wallet',
      actual: driveSettingsNav('d1', { ...cloud, onPrem: true }).map((item) => item.label),
      expected: ['Overview', 'General', 'Members & roles', 'Wallet', 'Commands', 'Context', 'Backups', 'Domains', 'Danger zone'],
    });
  });
});

describe('accountNav()', () => {
  test('no Privacy row in the native app', () => {
    assert({
      given: 'the native app',
      should: 'leave Privacy out, since the cookie screen renders nothing there',
      actual: accountNav({ ...cloud, isNative: true }).flatMap((group) => group.items).some((item) => item.label === 'Privacy'),
      expected: false,
    });
  });

  test('SPEC groups on cloud desktop with organization memberships', () => {
    assert({
      given: 'every gate open',
      should: 'list the account screens grouped YOU · AI · PLAN & DATA · CONNECTIONS · OTHER',
      actual: labels(accountNav({ ...cloud, isDesktop: true, hasOrganizations: true })),
      expected: [
        ['You', ['Overview', 'Profile', 'Display', 'Personalization', 'Notifications', 'Hotkeys', 'Privacy']],
        ['AI', ['AI providers', 'Agent accounts', 'Commands']],
        ['Plan & data', ['Plan', 'Billing', 'Usage', 'Wallets', 'Storage', 'Drives', 'Organizations', 'Backups', 'Trash']],
        ['Connections', ['Connections', 'Integrations', 'Google Calendar', 'MCP', 'Local MCP']],
        ['Other', ['Legal']],
      ],
    });
  });

  test('gates on a web on-prem build without billing or memberships', () => {
    const groups = accountNav({ ...cloud, onPrem: true, showBilling: false });
    assert({
      given: 'web, on-prem, no billing, no organizations',
      should: 'retain Wallets and Create, dropping Plan, Billing, Organizations, Integrations, Google Calendar and Local MCP',
      actual: [groups[2]?.items.map((item) => item.label), groups[3]?.items.map((item) => item.label)],
      expected: [
        ['Usage', 'Wallets', 'Storage', 'Drives', 'Create organization', 'Backups', 'Trash'],
        ['Connections', 'MCP'],
      ],
    });
  });

  test('paths', () => {
    const items = accountNav({ ...cloud, isDesktop: true }).flatMap((group) => group.items);
    assert({
      given: 'the account screens',
      should: 'link Profile, Google Calendar and Legal to their routes',
      actual: ['Profile', 'Google Calendar', 'Legal'].map((label) => items.find((item) => item.label === label)?.href),
      expected: ['/account/profile', '/account/integrations/google-calendar', '/account/legal'],
    });
  });
});

describe('activeNavHref()', () => {
  test('the longest matching row', () => {
    const items = accountNav({ ...cloud, isDesktop: true }).flatMap((group) => group.items);
    assert({
      given: 'a nested account path and the account root',
      should: 'mark Google Calendar for its page and Overview only for /account itself',
      actual: [activeNavHref(items, '/account/integrations/google-calendar'), activeNavHref(items, '/account'), activeNavHref(items, '/account/backups/b1/snapshot')],
      expected: ['/account/integrations/google-calendar', '/account', '/account/backups'],
    });
  });
});


describe('organization wallet final cutover', () => {
  test('personal wallets and a managed drive wallet are always discoverable', () => {
    expect(accountNav(cloud).flatMap(group => group.items)).toContainEqual({ label: 'Wallets', href: '/account/wallets' });
    expect(driveSettingsNav('d1', cloud, { role: 'OWNER', home: false })).toContainEqual({ label: 'Wallet', href: '/d1/settings/wallet' });
  });
  test('organizations follow membership, not a build flag', () => {
    const items = (hasOrganizations: boolean) => accountNav({ ...cloud, hasOrganizations }).flatMap(group => group.items);
    expect(items(false).some(item => item.label === 'Organizations')).toBe(false);
    expect(items(true)).toContainEqual({ label: 'Organizations', href: '/account/organizations' });
  });
});

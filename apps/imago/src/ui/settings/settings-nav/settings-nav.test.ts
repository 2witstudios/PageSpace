import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { accountNav, activeNavHref, driveSettingsNav, type NavContext } from './settings-nav';

const cloud: NavContext = { isDesktop: false, showBilling: true, isNative: false, onPrem: false, orgs: false };
const labels = (groups: ReturnType<typeof accountNav>) => groups.map((group) => [group.label, group.items.map((item) => item.label)]);

describe('driveSettingsNav() (IMC-1.11)', () => {
  test('SPEC order', () => {
    assert({
      given: 'a cloud drive with orgs on',
      should: 'list Overview through Danger zone in the SPEC’s fixed order',
      actual: driveSettingsNav('d1', { ...cloud, orgs: true }).map((item) => [item.label, item.href]),
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
      given: 'orgs off (Wallet) and an on-prem build (Integrations)',
      should: 'leave those rows out',
      actual: driveSettingsNav('d1', { ...cloud, onPrem: true }).map((item) => item.label),
      expected: ['Overview', 'General', 'Members & roles', 'Commands', 'Context', 'Backups', 'Domains', 'Danger zone'],
    });
  });
});

describe('accountNav()', () => {
  test('SPEC groups on cloud desktop with orgs on', () => {
    assert({
      given: 'every gate open',
      should: 'list the account screens grouped YOU · AI · PLAN & DATA · CONNECTIONS · OTHER',
      actual: labels(accountNav({ ...cloud, isDesktop: true, orgs: true })),
      expected: [
        ['You', ['Overview', 'Profile', 'Display', 'Personalization', 'Notifications', 'Hotkeys', 'Privacy']],
        ['AI', ['AI providers', 'Agents', 'Agent accounts', 'Commands']],
        ['Plan & data', ['Plan', 'Billing', 'Usage', 'Wallets', 'Storage', 'Drives', 'Organizations', 'Backups', 'Trash', 'Activity']],
        ['Connections', ['Connections', 'Integrations', 'Google Calendar', 'MCP', 'Local MCP', 'Calendar']],
        ['Other', ['Messages', 'Tasks', 'Legal']],
      ],
    });
  });

  test('gates on a web on-prem build without billing or orgs', () => {
    const groups = accountNav({ ...cloud, onPrem: true, showBilling: false });
    assert({
      given: 'web, on-prem, no billing, orgs off',
      should: 'drop Plan, Billing, Wallets, Organizations, Integrations, Google Calendar and Local MCP',
      actual: [groups[2]?.items.map((item) => item.label), groups[3]?.items.map((item) => item.label)],
      expected: [
        ['Usage', 'Storage', 'Drives', 'Backups', 'Trash', 'Activity'],
        ['Connections', 'MCP', 'Calendar'],
      ],
    });
  });

  test('paths', () => {
    const items = accountNav({ ...cloud, isDesktop: true }).flatMap((group) => group.items);
    assert({
      given: 'the account screens',
      should: 'link Profile, Google Calendar and Legal to their routes',
      actual: ['Profile', 'Google Calendar', 'Legal'].map((label) => items.find((item) => item.label === label)?.href),
      expected: ['/account/account', '/account/integrations/google-calendar', '/account/legal/oss-licenses'],
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

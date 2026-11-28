// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { DriveSettingsOverview } from './settings-overview';

afterEach(unmountAll);

const OWNED = { id: 'd1', name: 'Launch', kind: 'STANDARD', isOwned: true, role: 'MEMBER', publishSubdomain: 'launch', drivePrompt: 'abc' };
const MEMBER = { id: 'd1', name: 'Launch', kind: 'STANDARD', isOwned: false, role: 'MEMBER', publishSubdomain: null, drivePrompt: null };

/** apps/web's answers for the overview: each route as the settings routes answer them. */
const server = (drive: Record<string, unknown>, overrides: Record<string, FakeRoute> = {}) => ({
  'GET /api/drives/d1': () => Response.json(drive),
  'GET /api/drives/d1/members': () => Response.json({ members: [{ userId: 'u1', role: 'OWNER', user: { id: 'u1', email: 'a@x.test', name: 'Ada' }, profile: null, customRole: null }] }),
  'GET /api/drives/d1/agents/members': () => Response.json({ agentMembers: [{ id: 'a1' }] }),
  'GET /api/commands': () =>
    Response.json({
      commands: [
        { driveId: 'd1', enabled: true },
        { driveId: 'd1', enabled: false },
        { driveId: 'other', enabled: true },
      ],
    }),
  'GET /api/drives/d1/roles': () =>
    Response.json({ roles: [{ name: 'Editor', isDefault: true }, { name: 'Reviewer', isDefault: false }] }),
  'GET /api/drives/d1/integrations': () => Response.json({ connections: [{ name: 'Notion', status: 'expired' }] }),
  'GET /api/drives/d1/backups/schedule': () =>
    Response.json({ available: true, enabled: true, frequency: 'weekly', timezone: 'UTC', nextRunAt: null, lastRunAt: '2026-10-06T10:00:00.000Z' }),
  'GET /api/drives/d1/domains': () =>
    Response.json({ domains: [{ status: 'active' }, { status: 'pending' }], limit: 3 }),
  ...overrides,
});

const open = async (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const root = mount(
    <ImagoSWRProvider client={web.client}>
      <DriveSettingsOverview driveId="d1" />
    </ImagoSWRProvider>,
  );
  for (let tries = 0; tries < 150; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (root.querySelector('[data-settings-row="commands"]')?.textContent?.includes('off')) break;
  }
  return { web, root };
};

const rowsOf = (root: ParentNode) => [...root.querySelectorAll('[data-settings-row]')].map((node) => node.getAttribute('data-settings-row'));
const stateOf = (root: ParentNode, id: string) => root.querySelector(`[data-settings-row="${id}"] [data-row-state]`)?.textContent ?? null;

describe('DriveSettingsOverview', () => {
  test('owner: one h1, the identity line, and every row with its live hint', async () => {
    const { root } = await open(server(OWNED));
    assert({
      given: 'an owner whose drive has expired integrations, domains and a schedule',
      should: 'render the drive name once as the h1, with member counts and the published subdomain',
      actual: {
        h1: [...root.querySelectorAll('h1')].map((node) => node.textContent),
        lede: root.querySelector('header p')?.textContent,
      },
      expected: { h1: ['Launch'], lede: '1 person · 1 agent · Published at launch.pagespace.site' },
    });
    assert({
      given: 'an owner',
      should: 'list every settings row in the SPEC order, General without a hint',
      actual: { rows: rowsOf(root), general: stateOf(root, 'general') },
      expected: {
        rows: ['general', 'roles', 'integrations', 'commands', 'context', 'backups', 'domains', 'danger'],
        general: null,
      },
    });
    assert({
      given: 'the owner\'s answers from roles, integrations, commands, drive context, backups and domains',
      should: 'show each hint from its answer, the expired connection named and the drive-context length',
      actual: {
        roles: stateOf(root, 'roles'),
        integrations: stateOf(root, 'integrations'),
        commands: stateOf(root, 'commands'),
        context: stateOf(root, 'context'),
        backups: stateOf(root, 'backups'),
        domains: stateOf(root, 'domains'),
        danger: stateOf(root, 'danger'),
      },
      expected: {
        roles: 'Editor (default), Reviewer',
        integrations: 'Notion expired',
        commands: '2 commands · 1 off',
        context: '3 / 10,000 chars',
        backups: 'Weekly · last Oct 6',
        domains: '1 live · 1 waiting on DNS',
        danger: 'Drive lead only',
      },
    });
  });

  test('plain member: only Commands, and no request the member would be refused', async () => {
    const { root, web } = await open(server(MEMBER));
    assert({
      given: 'a plain member of the drive',
      should: 'show only the Commands row and no Danger zone',
      actual: rowsOf(root),
      expected: ['commands'],
    });
    assert({
      given: 'a plain member',
      should: 'ask only for the members, agents and commands answers',
      actual: {
        roles: web.count('GET /api/drives/d1/roles'),
        integrations: web.count('GET /api/drives/d1/integrations'),
        backups: web.count('GET /api/drives/d1/backups/schedule'),
        domains: web.count('GET /api/drives/d1/domains'),
      },
      expected: { roles: 0, integrations: 0, backups: 0, domains: 0 },
    });
  });
});

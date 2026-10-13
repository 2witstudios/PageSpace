// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { MembersPane } from './members-pane';
import { membersPaths } from './members-api';

vi.mock('@/realtime/realtime-provider', () => ({ useSocketEvent: () => undefined }));

const nav = vi.hoisted(() => ({ pathname: '/d1/members' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

afterEach(unmountAll);

const D = 'd1';

const fullRoutes = (): Record<string, FakeRoute> => ({
  [`GET ${membersPaths.members(D)}`]: () =>
    Response.json({
      members: [{ role: 'OWNER' }, { role: 'MEMBER' }, { role: 'ADMIN' }, { role: 'MEMBER' }, { role: 'GUEST' }],
      pendingInvites: [{ id: 'i1' }],
    }),
  [`GET ${membersPaths.agents(D)}`]: () => Response.json({ agentMembers: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }),
  [`GET ${membersPaths.apps(D)}`]: () => Response.json({ appMembers: [{ id: 'p1' }] }),
  [`GET ${membersPaths.shareLinks(D)}`]: () => Response.json({ links: [{ id: 'l1' }] }),
});

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

const show = (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <MembersPane driveId={D} close={null} />
    </ImagoSWRProvider>,
  );
  return { container };
};

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Member groups"] a')].map((link) => ({
    label: link.querySelector('span')?.textContent,
    count: link.querySelectorAll('span')[1]?.textContent,
    href: link.getAttribute('href'),
  }));

describe('MembersPane', () => {
  test('headed Members, with the group rows, live counts and their anchors', async () => {
    const { container } = show(fullRoutes());
    await settle(() => {
      if (rows(container).length === 0) throw new Error('not yet');
    });
    assert({
      given: 'a drive with people, a page-link guest, agents, an app, an invite and a link',
      should: 'list every group with its count, each jumping to its section',
      actual: {
        heading: container.querySelector('section[aria-label="Member groups"]')?.textContent?.startsWith('Members'),
        rows: rows(container),
      },
      expected: {
        heading: true,
        rows: [
          { label: 'Everyone', count: '9', href: '#everyone' },
          { label: 'People', count: '4', href: '#people' },
          { label: 'Guests', count: '1', href: '#page-link-guests' },
          { label: 'Agents', count: '3', href: '#agents' },
          { label: 'Apps', count: '1', href: '#apps' },
          { label: 'Pending invites', count: '1', href: '#pending' },
          { label: 'Invite links', count: '1', href: '#links' },
        ],
      },
    });
  });

  test('Manage: Invite someone and Roles & permissions', async () => {
    const { container } = show(fullRoutes());
    await settle(() => {
      if (rows(container).length === 0) throw new Error('not yet');
    });
    const manage = [...container.querySelectorAll('section[aria-label="Manage"] a')].map((a) => [a.textContent, a.getAttribute('href')]);
    assert({
      given: 'the Members pane',
      should: 'link Invite someone to the invite form and Roles & permissions to the drive roles screen',
      actual: manage,
      expected: [
        ['Invite someone', '/d1/members/invite'],
        ['Roles & permissions', '/d1/settings/roles'],
      ],
    });
  });

  test('no counts are shown while the roster loads', () => {
    const { container } = show({
      [`GET ${membersPaths.members(D)}`]: () => new Promise<Response>(() => undefined),
      [`GET ${membersPaths.agents(D)}`]: () => new Promise<Response>(() => undefined),
      [`GET ${membersPaths.apps(D)}`]: () => new Promise<Response>(() => undefined),
      [`GET ${membersPaths.shareLinks(D)}`]: () => new Promise<Response>(() => undefined),
    });
    assert({
      given: 'a roster still loading',
      should: 'show a loading line and no count',
      actual: [container.textContent?.includes('Loading members…'), rows(container).length],
      expected: [true, 0],
    });
  });

  test('a member without the invite links keeps the other counts and shows no link count', async () => {
    const routes = fullRoutes();
    routes[`GET ${membersPaths.shareLinks(D)}`] = () => Response.json({ error: 'Forbidden' }, { status: 403 });
    const { container } = show(routes);
    await settle(() => {
      if (rows(container).length === 0) throw new Error('not yet');
    });
    assert({
      given: 'a viewer the invite links are hidden from',
      should: 'leave the Invite links count empty and keep the other counts',
      actual: rows(container).map((row) => [row.label, row.count]),
      expected: [
        ['Everyone', '9'],
        ['People', '4'],
        ['Guests', '1'],
        ['Agents', '3'],
        ['Apps', '1'],
        ['Pending invites', '1'],
        ['Invite links', ''],
      ],
    });
  });

  test('on a member profile: All members back, then People with the current member marked, Agents and Guests', async () => {
    nav.pathname = '/d1/members/u2';
    const routes = fullRoutes();
    routes[`GET ${membersPaths.members(D)}`] = () =>
      Response.json({
        members: [
          { role: 'OWNER', userId: 'u1', user: { email: 'jono@studio.example', name: 'Jono' } },
          { role: 'MEMBER', userId: 'u2', user: { email: 'sam@studio.example' }, profile: { displayName: 'Sam Okafor' } },
          { role: 'GUEST', userId: 'u3', user: { email: 'marcus@example.com', name: 'Marcus Kim' } },
        ],
        pendingInvites: [],
      });
    routes[`GET ${membersPaths.agents(D)}`] = () => Response.json({ agentMembers: [{ title: 'Launch Agent' }] });
    const { container } = show(routes);
    await settle(() => {
      if (container.querySelectorAll('ul[aria-label="People"] a').length === 0) throw new Error('not yet');
    });
    const people = [...container.querySelectorAll('ul[aria-label="People"] a')].map((a) => [
      a.getAttribute('href'),
      a.getAttribute('aria-current'),
    ]);
    assert({
      given: 'a member profile open in the Members pane',
      should: 'link All members back, mark the current member aria-current, and list agents and guests',
      actual: {
        back: container.querySelector('section[aria-label="Members"] a')?.getAttribute('href'),
        people,
        agents: [...container.querySelectorAll('ul[aria-label="Agents"] li')].map((li) => li.textContent),
        guests: [...container.querySelectorAll('ul[aria-label="Guests"] li')].map((li) => li.textContent),
      },
      expected: {
        back: '/d1/members',
        people: [
          ['/d1/members/u1', null],
          ['/d1/members/u2', 'page'],
        ],
        agents: ['Launch Agent'],
        guests: ['Marcus KimGuest'],
      },
    });
    nav.pathname = '/d1/members';
  });

  test('on the invite form: Waiting to join with each invite expiry, and Or share a link', async () => {
    nav.pathname = '/d1/members/invite';
    const routes = fullRoutes();
    routes[`GET ${membersPaths.members(D)}`] = () =>
      Response.json({
        members: [],
        pendingInvites: [
          { id: 'i1', email: 'alex@freelance.example', role: 'MEMBER', customRoleName: 'Reviewer', expiresAt: '2099-10-16T12:00:00.000Z' },
          { id: 'i2', email: 'mo@studio.example', role: 'MEMBER', customRoleName: null, expiresAt: '2001-01-01T00:00:00.000Z' },
        ],
      });
    const { container } = show(routes);
    await settle(() => {
      if (container.querySelectorAll('ul[aria-label="Waiting to join"] li').length === 0) throw new Error('not yet');
    });
    assert({
      given: 'two invites waiting, one still open and one expired',
      should: 'list each invitee with its role and expiry, then the invite-link line',
      actual: {
        waiting: [...container.querySelectorAll('ul[aria-label="Waiting to join"] li')].map((li) => li.textContent),
        links: container.textContent?.includes('Or share a link'),
        manage: [...container.querySelectorAll('a')].find((a) => a.textContent === 'Manage links')?.getAttribute('href'),
      },
      expected: {
        waiting: ['alex@freelance.exampleReviewer · expires Oct 16', 'mo@studio.exampleMember · expired'],
        links: true,
        manage: '/d1/members#links',
      },
    });
    nav.pathname = '/d1/members';
  });
});

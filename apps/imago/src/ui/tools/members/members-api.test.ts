import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { fetchMembersDirectory, fetchMembersRoster, membersPaths } from './members-api';

const D = 'd1';
const member = (role: string) => ({ role });

describe('fetchMembersRoster()', () => {
  test('counts each kind from its route', async () => {
    const web = fakeWeb({
      [`GET ${membersPaths.members(D)}`]: () =>
        Response.json({ members: [member('OWNER'), member('MEMBER'), member('GUEST')], pendingInvites: [{ id: 'i1' }] }),
      [`GET ${membersPaths.agents(D)}`]: () => Response.json({ agentMembers: [{ id: 'a1' }, { id: 'a2' }] }),
      [`GET ${membersPaths.apps(D)}`]: () => Response.json({ appMembers: [{ id: 'p1' }] }),
      [`GET ${membersPaths.shareLinks(D)}`]: () => Response.json({ links: [{ id: 'l1' }] }),
    });
    assert({
      given: 'a drive with people, a page-link guest, agents, an app, an invite and a link',
      should: 'count each kind from the route that holds it',
      actual: await fetchMembersRoster(web.client, D),
      expected: { people: 2, guests: 1, agents: 2, apps: 1, pendingInvites: 1, inviteLinks: 1 },
    });
  });

  test('the invite links count stays undefined where the route refuses the viewer', async () => {
    const web = fakeWeb({
      [`GET ${membersPaths.members(D)}`]: () => Response.json({ members: [member('MEMBER')] }),
      [`GET ${membersPaths.agents(D)}`]: () => Response.json({ agentMembers: [] }),
      [`GET ${membersPaths.apps(D)}`]: () => Response.json({ appMembers: [] }),
      [`GET ${membersPaths.shareLinks(D)}`]: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const roster = await fetchMembersRoster(web.client, D);
    assert({
      given: 'a member who may not see invite links',
      should: 'leave the invite links count undefined and keep the rest',
      actual: [roster.inviteLinks, roster.people, roster.pendingInvites],
      expected: [undefined, 1, 0],
    });
  });
});

describe('fetchMembersDirectory()', () => {
  test('names the people, guests, agents and the waiting invites', async () => {
    const web = fakeWeb({
      [`GET ${membersPaths.members(D)}`]: () =>
        Response.json({
          members: [
            { role: 'OWNER', userId: 'u1', user: { email: 'jono@studio.example', name: 'Jono' } },
            { role: 'MEMBER', userId: 'u2', user: { email: 'sam@studio.example' }, profile: { displayName: 'Sam Okafor' } },
            { role: 'GUEST', userId: 'u3', user: { email: 'marcus@example.com' } },
          ],
          pendingInvites: [{ id: 'i1', email: 'alex@freelance.example', role: 'MEMBER', customRoleName: 'Reviewer', expiresAt: null }],
        }),
      [`GET ${membersPaths.agents(D)}`]: () => Response.json({ agentMembers: [{ title: 'Launch Agent' }, { title: null }] }),
    });
    assert({
      given: 'a drive with an owner, a member, a page-link guest, two agents and an invite',
      should: 'name each member (display name first), split guests out and keep the invites',
      actual: await fetchMembersDirectory(web.client, D),
      expected: {
        people: [
          { userId: 'u1', name: 'Jono', role: 'OWNER' },
          { userId: 'u2', name: 'Sam Okafor', role: 'MEMBER' },
        ],
        guests: [{ userId: 'u3', name: 'marcus@example.com', role: 'GUEST' }],
        agents: ['Launch Agent', 'Unnamed Agent'],
        pendingInvites: [{ id: 'i1', email: 'alex@freelance.example', role: 'MEMBER', customRoleName: 'Reviewer', expiresAt: null }],
      },
    });
  });
});


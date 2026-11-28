// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { DriveMembers } from './DriveMembers';

const spies = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), patch: vi.fn(), del: vi.fn(), post: vi.fn() }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  patch: spies.patch,
  del: spies.del,
  post: spies.post,
}));
vi.mock('@/retained-adapters/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/retained-adapters/navigation')>()),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/retained/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/retained/components/members/InviteAgentDialog', () => ({ InviteAgentDialog: () => null }));
vi.mock('@/retained/hooks/useDriveShareLink', () => ({
  useDriveShareLink: () => ({
    links: [],
    customRoles: [],
    selectedRole: { kind: 'member' },
    setSelectedRole: () => undefined,
    isLoading: false,
    isGenerating: false,
    revokingId: null,
    handleGenerate: () => undefined,
    handleCopy: () => undefined,
    handleRevoke: () => undefined,
  }),
}));

afterEach(unmountAll);

const member = (id: string, userId: string, role: string, name: string) => ({
  id,
  userId,
  role,
  invitedAt: '2026-04-28T00:00:00.000Z',
  acceptedAt: '2026-05-19T00:00:00.000Z',
  user: { id: userId, email: `${name.toLowerCase()}@studio.example` },
  profile: { displayName: name },
  customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 },
});

const roster = (currentUserRole: string) => ({
  members: [
    member('m1', 'u1', 'OWNER', 'Jono'),
    member('m2', 'u2', 'MEMBER', 'Sam Okafor'),
    member('m3', 'u3', 'GUEST', 'Marcus Kim'),
  ],
  pendingInvites: [
    {
      id: 'inv1',
      email: 'alex@studio.example',
      role: 'MEMBER',
      invitedByName: 'Jono',
      createdAt: '2026-10-09T00:00:00.000Z',
      expiresAt: '2099-01-16T12:00:00.000Z',
    },
  ],
  currentUserRole,
});

const routes = (currentUserRole: string): Record<string, unknown> => ({
  '/api/drives/d1/members': roster(currentUserRole),
  '/api/drives/d1/agents/members': {
    agentMembers: [{ id: 'a1', agentPageId: 'ap1', title: 'Ship status bot', role: 'MEMBER', addedAt: '2026-05-01', customRole: null }],
  },
  '/api/drives/d1/apps/members': {
    appMembers: [{ id: 'p1', tokenId: 't1', name: 'CI Publisher', role: 'MEMBER', createdAt: '2026-05-01', customRole: null }],
  },
  '/api/drives/d1/roles': { roles: [] },
});

const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const show = async (currentUserRole: string): Promise<HTMLElement> => {
  const table = routes(currentUserRole);
  spies.fetchWithAuth.mockImplementation(async (url: string) => respond(table[url] ?? {}));
  const container = mount(<DriveMembers driveId="d1" driveKind="standard" />);
  for (let tries = 0; tries < 100 && container.querySelector('section#people') === null; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return container;
};

const sectionIds = (container: HTMLElement) => [...container.querySelectorAll('section[id]')].map((section) => section.id);

describe('DriveMembers (C-Members)', () => {
  test('a manager sees the sections in board order, with links, guests and pending', async () => {
    const container = await show('ADMIN');
    assert({
      given: 'an admin of a drive',
      should: 'render Invite links, People, Page-link guests, Agents, Apps and Pending invites in board order',
      actual: sectionIds(container),
      expected: ['links', 'people', 'page-link-guests', 'agents', 'apps', 'pending'],
    });
  });

  test('page-link GUEST rows are listed under Page-link guests, not People', async () => {
    const container = await show('ADMIN');
    const people = container.querySelector('section#people')?.textContent ?? '';
    const guests = container.querySelector('section#page-link-guests')?.textContent ?? '';
    assert({
      given: 'a drive with a page-link guest',
      should: 'list the guest under Page-link guests and keep the People list to members',
      actual: [people.includes('Sam Okafor'), people.includes('Marcus Kim'), guests.includes('Marcus Kim')],
      expected: [true, false, true],
    });
  });

  test('the org source column, drive guests and Give a seat stay hidden', async () => {
    const container = await show('ADMIN');
    const text = container.textContent ?? '';
    assert({
      given: 'a drive with no org source to show',
      should: 'show no source legend, no Give a seat and no drive Guests section',
      actual: [text.includes('Give a seat'), text.includes('Lead ·'), container.querySelector('section#guests') !== null],
      expected: [false, false, false],
    });
  });

  test('agents and apps carry a role select and a labelled Remove', async () => {
    const container = await show('ADMIN');
    const labels = [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
    assert({
      given: 'an agent and an app with access',
      should: 'label their role selects and remove buttons by name',
      actual: ['Role for Ship status bot', 'Remove Ship status bot', 'Role for CI Publisher', 'Remove CI Publisher'].map((label) => labels.includes(label)),
      expected: [true, true, true, true],
    });
  });

  test('a pending invite shows who invited it, its expiry and a Revoke', async () => {
    const container = await show('ADMIN');
    const pending = container.querySelector('section#pending')?.textContent ?? '';
    assert({
      given: 'a pending invite',
      should: 'show Invited by, the expiry and a Revoke button',
      actual: [pending.includes('Invited by Jono'), pending.includes('Expires Jan 16, 2099'), container.querySelector('button[aria-label="Revoke invitation for alex@studio.example"]') !== null],
      expected: [true, true, true],
    });
  });

  test('a plain member sees no invite links, page-link guests or Invite', async () => {
    const container = await show('MEMBER');
    assert({
      given: 'a member who is not an admin',
      should: 'see the people and the agents and apps, and none of the management sections',
      actual: sectionIds(container),
      expected: ['people', 'agents', 'apps'],
    });
  });
});

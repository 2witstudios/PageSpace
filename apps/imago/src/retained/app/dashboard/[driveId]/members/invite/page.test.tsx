// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import InviteMemberPage from './page';

const spies = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), post: vi.fn(), push: vi.fn() }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  patch: vi.fn(),
  del: vi.fn(),
  post: spies.post,
}));
vi.mock('@/retained-adapters/navigation', () => ({
  useParams: () => ({ driveId: 'd1' }),
  useRouter: () => ({ push: spies.push }),
}));
vi.mock('swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('swr')>()),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/retained/components/members/UserSearch', async () => {
  const { createElement } = await import('react');
  return {
    UserSearch: ({ onSelect, onInviteEmail }: { onSelect: (u: { userId: string; displayName: string }) => void; onInviteEmail: (email: string) => void }) =>
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', onClick: () => onInviteEmail('ava@kimdesign.example') }, 'Invite by email'),
        createElement('button', { type: 'button', onClick: () => onSelect({ userId: 'u9', displayName: 'Ava Kim' }) }, 'Pick Ava'),
      ),
  };
});

// Radix measures its radios with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const json = (body: unknown) => Promise.resolve(Response.json(body));

const ROLES = [{ id: 'r1', name: 'Reviewer', isDefault: true, permissions: {} }];

beforeEach(() => {
  spies.post.mockReset().mockResolvedValue({ kind: 'invited' });
  spies.push.mockReset();
  spies.fetchWithAuth.mockReset().mockImplementation((url: string) => {
    if (url === '/api/drives/d1/roles') return json({ roles: ROLES });
    if (url === '/api/drives/d1/permissions-tree') {
      return json({ pages: [{ id: 'p1', title: 'Pricing Model', type: 'DOCUMENT', children: [] }] });
    }
    return json({});
  });
});

afterEach(unmountAll);

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet.
    }
  }
  check();
};

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;

const radio = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => container.querySelector(`label[for="${r.id}"]`)?.textContent?.includes(label)) ?? null;

const headings = (container: HTMLElement) => [...container.querySelectorAll('h2')].map((h) => h.textContent?.replace(/^\d/, ''));

describe('InviteMemberPage', () => {
  test('starts with Who only, then an email match shows Role and the expiry, with no page grid', async () => {
    const { container } = { container: mount(<InviteMemberPage />) };
    await settle(() => {
      if (button(container, 'Invite by email') === null) throw new Error('not yet');
    });
    click(button(container, 'Invite by email')!);
    await settle(() => {
      if (radio(container, 'Never') === null) throw new Error('not yet');
    });
    assert({
      given: 'an email typed in Who',
      should: 'show Role and Invite expiry (Never, 1, 7, 30 days), and no page permissions grid',
      actual: {
        headings: headings(container),
        expiry: ['Never', '1 day', '7 days', '30 days'].map((label) => radio(container, label) !== null),
        grid: container.querySelector('[role="treegrid"]') !== null,
        sendLabel: button(container, 'Send invite')?.textContent,
      },
      expected: {
        headings: ['Who', 'Role', 'Invite expiry'],
        expiry: [true, true, true, true],
        grid: false,
        sendLabel: 'Send invite',
      },
    });
  });

  test('an email invite posts the role and the chosen expiry through the invite route', async () => {
    const { container } = { container: mount(<InviteMemberPage />) };
    await settle(() => {
      if (button(container, 'Invite by email') === null) throw new Error('not yet');
    });
    click(button(container, 'Invite by email')!);
    await settle(() => {
      if (radio(container, '30 days') === null) throw new Error('not yet');
    });
    click(radio(container, '30 days')!);
    click(button(container, 'Send invite')!);
    await settle(() => {
      if (spies.post.mock.calls.length === 0) throw new Error('not yet');
    });
    assert({
      given: 'an email invite with the Reviewer default role and a 30 day expiry',
      should: 'POST the email, the role, an empty permissions list and expiryDays to members/invite',
      actual: spies.post.mock.calls[0],
      expected: [
        '/api/drives/d1/members/invite',
        { email: 'ava@kimdesign.example', role: 'MEMBER', customRoleId: 'r1', permissions: [], expiryDays: 30 },
      ],
    });
  });

  test('a joined user with No role reveals the page permissions grid; Admin hides it', async () => {
    const { container } = { container: mount(<InviteMemberPage />) };
    await settle(() => {
      if (button(container, 'Pick Ava') === null) throw new Error('not yet');
    });
    click(button(container, 'Pick Ava')!);
    await settle(() => {
      if (radio(container, 'No role') === null) throw new Error('not yet');
    });
    click(radio(container, 'No role')!);
    await settle(() => {
      if (container.querySelector('[role="treegrid"][aria-label="Page permissions"]') === null) throw new Error('not yet');
    });
    const withNoRole = container.querySelector('[role="treegrid"]') !== null;
    click(radio(container, 'Admin')!);
    await settle(() => {
      if (container.querySelector('[role="treegrid"]') !== null) throw new Error('not yet');
    });
    assert({
      given: 'a joined user picked in Who',
      should: 'show the page grid under No role, and hide it again for Admin, with no expiry step',
      actual: {
        withNoRole,
        afterAdmin: container.querySelector('[role="treegrid"]') !== null,
        expiry: headings(container).includes('Invite expiry'),
      },
      expected: { withNoRole: true, afterAdmin: false, expiry: false },
    });
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import MemberSettingsPage from './page';

const spies = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), patch: vi.fn(), del: vi.fn(), push: vi.fn() }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  patch: spies.patch,
  del: spies.del,
  post: vi.fn(),
}));
vi.mock('@/retained-adapters/navigation', () => ({
  useParams: () => ({ driveId: 'd1', userId: 'u2' }),
  useRouter: () => ({ push: spies.push }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const orgState = vi.hoisted(() => ({ lapsed: false }));
vi.mock('@/retained/hooks/useOrgLapsed', () => ({ useOrgLapsed: () => orgState.lapsed, LAPSED_LOOSEN_NOTE: 'Removing access still works.' }));
vi.mock('@/retained/hooks/useDrive', () => ({ useDriveStore: (select: (state: { drives: { id: string; orgId: string }[] }) => unknown) => select({ drives: [{ id: 'd1', orgId: 'northwind' }] }) }));

const SESSION = 'member-permissions:u2';

const json = (body: unknown) => Promise.resolve(Response.json(body));

const serve = () => {
  spies.fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/api/drives/d1/members/u2') {
      return json({
        member: {
          id: 'm2',
          userId: 'u2',
          role: 'MEMBER',
          customRoleId: null,
          invitedAt: '2026-04-28T12:00:00.000Z',
          acceptedAt: '2026-05-19T12:00:00.000Z',
          user: { id: 'u2', email: 'sam@studio.example' },
          profile: { username: 'sam', displayName: 'Sam Okafor' },
          drive: { id: 'd1', name: 'Studio', slug: 'studio', ownerId: 'u1' },
        },
        permissions: [{ pageId: 'p1', canView: true, canEdit: false, canShare: false }],
      });
    }
    if (url === '/api/drives/d1/roles') return json({ roles: [] });
    if (url === '/api/drives/d1/permissions-tree?userId=u2') {
      return json({
        pages: [
          { id: 'p1', title: 'Pricing Model', type: 'DOCUMENT', children: [] },
          { id: 'p2', title: 'launch-ops', type: 'FOLDER', children: [] },
        ],
      });
    }
    return json({});
  });
};

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

const shareBox = (container: HTMLElement, title: string) =>
  container.querySelector<HTMLElement>(`[role="checkbox"][aria-label="Share ${title}"]`);

const bar = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="region"][aria-label="Unsaved changes"]');

beforeEach(() => {
  orgState.lapsed = false;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  spies.fetchWithAuth.mockReset();
  spies.patch.mockReset().mockResolvedValue({});
  spies.del.mockReset().mockResolvedValue({});
  spies.push.mockReset();
  serve();
  useEditingStore.getState().clearAllSessions();
});

afterEach(unmountAll);

describe('MemberSettingsPage', () => {
  test('shows the member header and the page permissions treegrid, with no dirty bar until something changes', async () => {
    const { container } = { container: mount(<MemberSettingsPage />) };
    await settle(() => {
      if (container.querySelector('[role="treegrid"][aria-label="Page permissions"]') === null) throw new Error('not yet');
    });
    assert({
      given: 'a member with one page permission',
      should: 'show the name, the email, username and dates, the treegrid, and no unsaved bar',
      actual: {
        heading: container.querySelector('h1')?.textContent,
        line: container.querySelector('header p')?.textContent,
        removeButton: [...container.querySelectorAll('button')].some((b) => b.textContent === 'Remove from drive'),
        bar: bar(container) !== null,
        session: useEditingStore.getState().activeSessions.has(SESSION),
      },
      expected: {
        heading: 'Sam Okafor',
        line: 'sam@studio.example · @sam · invited Apr 28 · joined May 19',
        removeButton: true,
        bar: false,
        session: false,
      },
    });
  });

  test('a permission edit shows the dirty bar, registers the editing session, and Discard reverts it', async () => {
    const { container } = { container: mount(<MemberSettingsPage />) };
    await settle(() => {
      if (shareBox(container, 'Pricing Model') === null) throw new Error('not yet');
    });
    click(shareBox(container, 'Pricing Model')!);
    const dirty = bar(container);
    const summary = dirty?.querySelector('span')?.textContent;
    const registered = useEditingStore.getState().activeSessions.has(SESSION);
    click([...(dirty?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Discard')!);
    assert({
      given: 'Share ticked on a page the member can already view',
      should: 'name the one changed page, hold the editing store while dirty, and clear both on Discard',
      actual: {
        summary,
        registered,
        barAfterDiscard: bar(container) !== null,
        sessionAfterDiscard: useEditingStore.getState().activeSessions.has(SESSION),
        shareAfterDiscard: shareBox(container, 'Pricing Model')?.getAttribute('aria-checked'),
      },
      expected: {
        summary: '1 permission change on Pricing Model',
        registered: true,
        barAfterDiscard: false,
        sessionAfterDiscard: false,
        shareAfterDiscard: 'false',
      },
    });
  });

  test('Save changes sends the permissions to PATCH members/[userId] and clears the bar', async () => {
    const { container } = { container: mount(<MemberSettingsPage />) };
    await settle(() => {
      if (shareBox(container, 'Pricing Model') === null) throw new Error('not yet');
    });
    click(shareBox(container, 'Pricing Model')!);
    click([...(bar(container)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Save changes')!);
    await settle(() => {
      if (bar(container) !== null) throw new Error('not yet');
    });
    assert({
      given: 'a page Share ticked and saved',
      should: 'PATCH the member with the page rows, then drop the dirty state',
      actual: {
        patched: spies.patch.mock.calls[0]?.[0],
        body: spies.patch.mock.calls[0]?.[1],
        session: useEditingStore.getState().activeSessions.has(SESSION),
      },
      expected: {
        patched: '/api/drives/d1/members/u2',
        body: {
          role: 'MEMBER',
          customRoleId: null,
          permissions: [
            { pageId: 'p1', canView: true, canEdit: false, canShare: true },
          ],
        },
        session: false,
      },
    });
  });

  test('SEAT-9 (partial) lapsed org page permission widening cannot be saved while narrowing still can', async () => {
    orgState.lapsed = true;
    const container = mount(<MemberSettingsPage />);
    await settle(() => expect(shareBox(container, 'Pricing Model')).not.toBeNull());
    click(shareBox(container, 'Pricing Model')!);
    const save = () => [...(bar(container)?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Save changes')!;
    expect(save().disabled).toBe(true);
    expect(container.textContent).toContain('Giving this member more is paused.');
    click(save());
    expect(spies.patch).not.toHaveBeenCalled();
    click([...(bar(container)?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Discard')!);
    const view = container.querySelector<HTMLElement>('[role="checkbox"][aria-label="View Pricing Model"]')!;
    click(view);
    expect(save().disabled).toBe(false);
    click(save());
    await settle(() => expect(spies.patch).toHaveBeenCalledWith('/api/drives/d1/members/u2', expect.objectContaining({ permissions: [{ pageId: 'p1', canView: false, canEdit: false, canShare: false }] })));
  });

  test('SEAT-9 (partial) lapsed org promotion to Admin cannot be saved', async () => {
    orgState.lapsed = true;
    const container = mount(<MemberSettingsPage />);
    await settle(() => expect(container.querySelector('[role="combobox"]')).not.toBeNull());
    const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
    act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await settle(() => expect([...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Admin'))).toBeTruthy());
    click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes('Admin'))!);
    const save = [...(bar(container)?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Save changes')!;
    expect(save.disabled).toBe(true);
    click(save);
    expect(spies.patch).not.toHaveBeenCalled();
  });

});

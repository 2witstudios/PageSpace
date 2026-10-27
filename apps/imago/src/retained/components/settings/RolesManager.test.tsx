// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';
import { RolesManager } from './RolesManager';

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
}));
const socket = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    },
    off: (event: string) => {
      handlers.delete(event);
    },
  };
});
vi.mock('@/retained/hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('@/retained/components/members/PermissionsGrid', () => ({
  PermissionsGrid: () => <div data-testid="access-grid">Page access grid</div>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const roles = [
  {
    id: 'r1',
    name: 'Editor',
    description: 'Writes launch material; reads research.',
    color: 'green',
    isDefault: true,
    permissions: {},
    driveWidePermissions: null,
    position: 0,
  },
  {
    id: 'r2',
    name: 'Reviewer',
    description: 'View everything except Hiring',
    color: 'purple',
    isDefault: false,
    permissions: {},
    driveWidePermissions: null,
    position: 1,
  },
];

const respondWith = (list: typeof roles) =>
  vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ roles: list }) } as unknown as Response);

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text);
const roleRow = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((button) => button.textContent?.includes(name));
const roleList = (root: ParentNode) => root.querySelector<HTMLElement>('[role="group"][aria-label="Role list"]');

beforeAll(() => {
  // Radix measures its switch with ResizeObserver, which jsdom does not provide.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.mocked(patch).mockClear();
  respondWith(roles);
});

afterEach(unmountAll);

describe('RolesManager', () => {
  test('lists the built-in Admin and Member rows and the custom roles, without holder counts', async () => {
    const container = mount(<RolesManager driveId="d1" />);
    await flush();
    const list = roleList(container);
    assert({
      given: 'Admin and Member built-in plus two custom roles, one of them the default',
      should: 'list every role with its description and Default on the default role only, and show no holder counts',
      actual: {
        builtIn: [list?.textContent?.includes('Full access to all pages and settings'), list?.textContent?.includes('View only · read access to non-private pages')],
        custom: ['Editor', 'Writes launch material; reads research.', 'Reviewer', 'View everything except Hiring'].map((text) => list?.textContent?.includes(text)),
        defaultPills: (list?.textContent?.split('Default').length ?? 1) - 1,
        holders: /holder/i.test(container.textContent ?? ''),
      },
      expected: { builtIn: [true, true], custom: [true, true, true, true], defaultPills: 1, holders: false },
    });
  });

  test('New role opens its editor inline under the list, not in a dialog', async () => {
    const container = mount(<RolesManager driveId="d1" />);
    await flush();
    click(byText(container, 'New role')!);
    assert({
      given: 'a drive owner who clicks New role',
      should: 'show a New role section beneath the role list, keep the list, and open no dialog',
      actual: {
        heading: container.querySelector('#role-editor-title')?.textContent,
        listKept: roleList(container) !== null,
        dialog: document.querySelector('[role="dialog"]') !== null,
        grid: container.querySelector('[data-testid="access-grid"]') !== null,
      },
      expected: { heading: 'New role', listKept: true, dialog: false, grid: true },
    });
  });

  test('selecting a role edits it inline with its name, colour, description and default switch', async () => {
    const container = mount(<RolesManager driveId="d1" />);
    await flush();
    click(roleRow(container, 'Editor')!);
    assert({
      given: 'the Editor role selected from the list',
      should: 'open Editing “Editor” with its Name, Description, Default role switch on and its colour pressed',
      actual: {
        heading: container.querySelector('#role-editor-title')?.textContent,
        name: container.querySelector<HTMLInputElement>('#name')?.value,
        description: container.querySelector<HTMLTextAreaElement>('#description')?.value,
        defaultSwitch: container.querySelector('#role-default')?.getAttribute('aria-checked'),
        pressed: [...container.querySelectorAll('[aria-label^="Select "][aria-pressed="true"]')].map((node) => node.getAttribute('aria-label')),
      },
      expected: {
        heading: 'Editing “Editor”',
        name: 'Editor',
        description: 'Writes launch material; reads research.',
        defaultSwitch: 'true',
        pressed: ['Select green color'],
      },
    });
  });

  test('saving an edited role PATCHes its roles/[roleId] route with the new name', async () => {
    const container = mount(<RolesManager driveId="d1" />);
    await flush();
    click(roleRow(container, 'Reviewer')!);
    typeInto(container.querySelector<HTMLInputElement>('#name')!, 'Auditor');
    click(byText(container, 'Save role')!);
    await flush();
    const body = vi.mocked(patch).mock.calls[0]?.[1] as { name?: string } | undefined;
    assert({
      given: 'the Reviewer role renamed to Auditor in the inline editor',
      should: 'PATCH drives/[driveId]/roles/[roleId] with the new name',
      actual: { url: vi.mocked(patch).mock.calls[0]?.[0], name: body?.name },
      expected: { url: '/api/drives/d1/roles/r2', name: 'Auditor' },
    });
  });

  test('a name typed into the open editor survives a roles refresh from the socket', async () => {
    const container = mount(<RolesManager driveId="d1" />);
    await flush();
    click(roleRow(container, 'Reviewer')!);
    typeInto(container.querySelector<HTMLInputElement>('#name')!, 'Auditor');
    const fetchesBefore = vi.mocked(fetchWithAuth).mock.calls.length;
    await act(async () => {
      socket.handlers.get('drive:updated')?.({ driveId: 'd1' });
    });
    await flush();
    assert({
      given: 'an unsaved rename in the editor when drive:updated refreshes the roles',
      should: 'refetch the roles and keep the typed name rather than resetting the editor',
      actual: {
        refetched: vi.mocked(fetchWithAuth).mock.calls.length > fetchesBefore,
        name: container.querySelector<HTMLInputElement>('#name')?.value,
      },
      expected: { refetched: true, name: 'Auditor' },
    });
  });
});

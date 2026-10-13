// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import MCPSettingsView from './MCPSettingsView';

const spies = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  post: spies.post,
  del: spies.del,
  patch: spies.patch,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const tokenRows = [
  {
    id: 't1',
    name: 'Claude Desktop · MacBook',
    lastUsed: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    isScoped: false,
    driveScopes: [],
  },
  {
    id: 't2',
    name: 'Cursor · Studio repo',
    lastUsed: '2026-10-10T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
    isScoped: true,
    driveScopes: [{ id: 'd1', name: 'Studio', role: 'MEMBER', customRoleId: null, customRoleName: null }],
  },
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body });

const byText = (container: HTMLElement, tag: string, text: string): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>(tag)].find((el) => el.textContent?.trim() === text);

/** Radix Tabs activate on mousedown, not click. */
const selectTab = (container: HTMLElement, label: string): void => {
  const tab = byText(container, '[role="tab"]', label)!;
  act(() => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
};

beforeEach(() => {
  spies.fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === '/api/auth/mcp-tokens') return jsonResponse(tokenRows);
    if (url.startsWith('/api/drives')) return jsonResponse([{ id: 'd1', name: 'Studio', role: 'ADMIN' }]);
    return jsonResponse({ roles: [] });
  });
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('MCPSettingsView', () => {
  test('renders each token with its created and last-used line, scope pill, Edit scopes and Revoke', async () => {
    const container = mount(<MCPSettingsView />);
    await flush();
    const group = container.querySelector('[aria-label="Your tokens"]')!;
    assert({
      given: 'two saved tokens, one all-drives and one scoped to Studio as Member',
      should: 'render Edit scopes and a named Revoke button for each row, with the scope pill',
      actual: {
        headings: container.querySelector('section[aria-label="Your tokens 2"]') !== null,
        edit: group.querySelectorAll('button').length,
        revokeFirst: container.querySelector('button[aria-label="Revoke Claude Desktop · MacBook"]') !== null,
        pills: [...group.querySelectorAll('span')].map((s) => s.textContent).filter((t) => t === 'All drives' || t?.startsWith('Studio')),
        neverUsed: group.textContent?.includes('never used'),
      },
      expected: {
        headings: true,
        edit: 4,
        revokeFirst: true,
        pills: ['All drives', 'Studio · Member'],
        neverUsed: true,
      },
    });
  });

  test('shows the one-time token value with Copy right after a token is created', async () => {
    spies.post.mockResolvedValue({ id: 't3', name: 'CI sync bot', token: 'mcp_fresh_value', createdAt: '2026-10-12T00:00:00.000Z', lastUsed: null });
    const container = mount(<MCPSettingsView />);
    await flush();
    click(byText(container, 'button', 'New token')!);
    await flush();
    const name = document.querySelector<HTMLInputElement>('#token-name')!;
    typeInto(name, 'CI sync bot');
    click(byText(document.body, 'button', 'Create Token')!);
    await flush();
    const status = container.querySelector('[role="status"]');
    assert({
      given: 'a token created in the dialog',
      should: 'show the one-time value with Copy and the copy-now warning in the status banner',
      actual: {
        banner: status?.textContent?.includes('Token created — “CI sync bot”') ?? false,
        value: status?.textContent?.includes('mcp_fresh_value') ?? false,
        copy: byText(status as HTMLElement, 'button', 'Copy') !== undefined,
        warning: status?.textContent?.includes("Copy it now. Existing token values can't be shown again.") ?? false,
      },
      expected: { banner: true, value: true, copy: true, warning: true },
    });
  });

  test('switches Quick setup to the npx steps with a config that launches via npx', async () => {
    const container = mount(<MCPSettingsView />);
    await flush();
    selectTab(container, 'No install (npx)');
    await flush();
    const pres = [...container.querySelectorAll('pre')].map((p) => p.textContent ?? '');
    assert({
      given: 'the No install (npx) setup style',
      should: 'show the npx launch command in the config JSON and no global install step',
      actual: {
        npx: pres.some((text) => text.includes('"command": "npx"') && text.includes('"@pagespace/cli"')),
        noInstallStep: pres.some((text) => text.includes('npm install -g @pagespace/cli')),
      },
      expected: { npx: true, noInstallStep: false },
    });
  });

  test('shows the OpenAI-compatible base URL with a Copy button', async () => {
    const container = mount(<MCPSettingsView />);
    await flush();
    const row = [...container.querySelectorAll<HTMLElement>('div')].find((div) =>
      div.querySelector('code')?.textContent?.endsWith('/api/v1'),
    );
    assert({
      given: 'the OpenAI-compatible section',
      should: 'render the /api/v1 base URL beside a Copy button',
      actual: {
        url: container.textContent?.includes('/api/v1') ?? false,
        copy: row ? byText(row as HTMLElement, 'button', 'Copy') !== undefined : false,
      },
      expected: { url: true, copy: true },
    });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { PasskeyManager } from './PasskeyManager';

const spies = vi.hoisted(() => ({ useSWR: vi.fn() }));

vi.mock('swr', () => ({
  default: spies.useSWR,
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: () => true,
}));
vi.mock('@/retained/hooks/useCSRFToken', () => ({ useCSRFToken: () => ({ csrfToken: 'token' }) }));
vi.mock('@/retained/lib/desktop-auth', () => ({
  isDesktopPlatform: () => false,
  getDevicePlatformFields: vi.fn(),
}));
vi.mock('@/retained/components/auth/passkeyExternal', () => ({ buildPasskeyRegisterExternalUrl: vi.fn() }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(unmountAll);

const PASSKEYS = [
  {
    id: 'p1',
    name: 'MacBook Pro — Touch ID',
    deviceType: 'multiDevice',
    backedUp: true,
    lastUsedAt: '2026-09-09T10:00:00Z',
    createdAt: '2025-03-04T10:00:00Z',
  },
  {
    id: 'p2',
    name: 'YubiKey 5C',
    deviceType: 'singleDevice',
    backedUp: false,
    lastUsedAt: null,
    createdAt: '2025-06-18T10:00:00Z',
  },
];

const useList = (passkeys: unknown[] | undefined, error?: Error) => {
  spies.useSWR.mockReturnValue({ data: passkeys ? { passkeys } : undefined, error, isLoading: !passkeys && !error });
};

const syncedBadges = (container: HTMLElement) =>
  [...container.querySelectorAll('span')].filter((s) => s.textContent === 'Synced').length;

describe('PasskeyManager', () => {
  test('shows a Synced badge only for passkeys the API reports as backed up', () => {
    useList(PASSKEYS);
    const container = mount(<PasskeyManager />);
    assert({
      given: 'one backed-up passkey and one hardware key',
      should: 'show exactly one "Synced" badge',
      actual: syncedBadges(container),
      expected: 1,
    });
  });

  test('labels each row Remove <name> and shows the added date and last-used date when present', () => {
    useList(PASSKEYS);
    const container = mount(<PasskeyManager />);
    const text = container.textContent ?? '';
    assert({
      given: 'two passkeys, only one of which has been used',
      should: 'give each a "Remove <name>" button and show "last used" only for the used passkey',
      actual: {
        removeMac: container.querySelector('button[aria-label="Remove MacBook Pro — Touch ID"]')?.textContent,
        removeYubi: container.querySelector('button[aria-label="Remove YubiKey 5C"]')?.textContent,
        addedLines: text.split('Added ').length - 1,
        lastUsedLines: text.split('last used').length - 1,
      },
      expected: { removeMac: 'Remove', removeYubi: 'Remove', addedLines: 2, lastUsedLines: 1 },
    });
  });

  test('falls back to "Unnamed Passkey" for a passkey without a name', () => {
    useList([{ ...PASSKEYS[1], name: null }]);
    const container = mount(<PasskeyManager />);
    assert({
      given: 'a passkey with no name',
      should: 'label its remove button "Remove Unnamed Passkey"',
      actual: container.querySelector('button[aria-label="Remove Unnamed Passkey"]') !== null,
      expected: true,
    });
  });

  test('shows the empty state and an "Add passkey" button when none are registered', () => {
    useList([]);
    const container = mount(<PasskeyManager />);
    assert({
      given: 'no registered passkeys',
      should: 'say none are registered and offer "Add passkey" without any Remove buttons',
      actual: {
        empty: container.textContent?.includes('No passkeys registered yet.'),
        add: [...container.querySelectorAll('button')].some((b) => b.textContent === 'Add passkey'),
        remove: container.querySelector('button[aria-label^="Remove"]'),
      },
      expected: { empty: true, add: true, remove: null },
    });
  });
});

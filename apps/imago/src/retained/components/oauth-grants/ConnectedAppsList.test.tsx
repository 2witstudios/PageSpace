// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { ConnectedAppsList } from './ConnectedAppsList';

const spies = vi.hoisted(() => ({ useOAuthGrants: vi.fn() }));

vi.mock('@/retained/hooks/useOAuthGrants', () => ({ useOAuthGrants: spies.useOAuthGrants }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ del: vi.fn() }));
vi.mock('@/retained/lib/auth/step-up-ceremony', () => ({
  attemptStepUp: vi.fn(),
  readStepUpTokenFromHash: vi.fn(() => null),
  stripStepUpTokenFromHash: vi.fn(() => ''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(unmountAll);

const GRANTS = [
  { id: 'g1', clientName: 'pagespace CLI', scopeDescriptions: ['Read pages'], createdAt: '2026-09-30T12:00:00Z' },
  { id: 'g2', clientName: 'PageSpace Desktop', scopeDescriptions: [], createdAt: '2026-08-12T12:00:00Z' },
];

const useGrants = (grants: typeof GRANTS | undefined) => {
  spies.useOAuthGrants.mockReturnValue({ grants, isLoading: false, isError: undefined, refetch: vi.fn() });
};

describe('ConnectedAppsList', () => {
  test('labels each app row with its name, an "Authorized" date and a named Revoke button', () => {
    useGrants(GRANTS);
    const container = mount(<ConnectedAppsList />);
    const text = container.textContent ?? '';
    assert({
      given: 'two authorized apps',
      should: 'show each app name, an "Authorized <date>" line and a "Revoke <name>" button',
      actual: {
        names: ['pagespace CLI', 'PageSpace Desktop'].every((name) => text.includes(name)),
        authorized: text.includes('Authorized') && text.includes('2026'),
        revokeButtons: ['Revoke pagespace CLI', 'Revoke PageSpace Desktop'].every(
          (label) => container.querySelector(`button[aria-label="${label}"]`) !== null,
        ),
      },
      expected: { names: true, authorized: true, revokeButtons: true },
    });
  });

  test('omits a "last used" line because the grant carries no lastUsedAt', () => {
    useGrants(GRANTS);
    const container = mount(<ConnectedAppsList />);
    assert({
      given: 'grants from the oauth-grants API, which has no last-used field',
      should: 'not render any "last used" text',
      actual: /last used/i.test(container.textContent ?? ''),
      expected: false,
    });
  });

  test('shows the empty state when there are no connected apps', () => {
    useGrants([]);
    const container = mount(<ConnectedAppsList />);
    assert({
      given: 'no grants',
      should: 'say there are no connected apps and render no Revoke buttons',
      actual: {
        text: container.textContent?.includes('No connected apps.'),
        revoke: container.querySelector('button[aria-label^="Revoke"]'),
      },
      expected: { text: true, revoke: null },
    });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

const fixtures = vi.hoisted(() => ({
  accounts: [
    {
      id: 'a1',
      name: 'Stripe (test mode)',
      status: 'active',
      ready: true,
      acknowledgment: 'dedicated_agent_account',
      allowedOrigins: ['https://api.stripe.com'],
      lastUsedAt: null,
    },
    {
      id: 'a2',
      name: 'Linear',
      status: 'active',
      ready: false,
      acknowledgment: 'dedicated_agent_account',
      allowedOrigins: ['https://api.linear.app'],
      lastUsedAt: null,
    },
  ] as Array<Record<string, unknown>>,
}));

vi.mock('@/retained/hooks/useAgentAccounts', () => ({
  agentAccountsUrl: () => '/api/user/agent-accounts',
  useAgentAccounts: () => ({
    configured: true,
    accounts: fixtures.accounts,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ post: vi.fn() }));

const { AgentAccountsPanel } = await import('./AgentAccountsPanel');

afterEach(unmountAll);

describe('AgentAccountsPanel on the account route (IMC-7.30)', () => {
  test('lists each account with its status and a Revoke button named for it', () => {
    const root = mount(<AgentAccountsPanel scope={{ kind: 'user' }} layout="page" />);
    assert({
      given: 'two active accounts',
      should: 'list them by name and label each Revoke button with the account name',
      actual: [
        root.querySelector('[aria-label="Revoke Stripe (test mode)"]') !== null,
        root.querySelector('[aria-label="Revoke Linear"]') !== null,
        root.textContent?.includes('api.linear.app'),
      ],
      expected: [true, true, true],
    });
  });

  test('an account whose credential is unusable reads Not ready, and the others do not', () => {
    const root = mount(<AgentAccountsPanel scope={{ kind: 'user' }} layout="page" />);
    assert({
      given: 'an active account with an unusable credential',
      should: 'show "Not ready — add it again" once, beside that account',
      actual: Array.from(root.querySelectorAll('*')).filter((el) => el.textContent === 'Not ready — add it again').length,
      expected: 1,
    });
  });

  test('the add form is inline, not a dialog, and cannot submit while empty', () => {
    const root = mount(<AgentAccountsPanel scope={{ kind: 'user' }} layout="page" />);
    const addButton = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Add account');
    assert({
      given: 'the account route with no draft',
      should: 'render the Add an account form inline with a disabled Add account button and no dialog',
      actual: [
        root.textContent?.includes('Add an account'),
        root.querySelector('[role="dialog"]'),
        addButton?.hasAttribute('disabled'),
      ],
      expected: [true, null, true],
    });
  });
});

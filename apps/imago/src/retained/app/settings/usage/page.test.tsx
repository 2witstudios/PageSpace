// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import UsagePage from './page';
import { patch } from '@/retained/lib/auth/auth-fetch';

const state = vi.hoisted(() => ({ billingHidden: false, query: '' }));

const fixtures = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: fixtures[key],
    error: undefined,
    isLoading: false,
    mutate: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as () => unknown)() : undefined)),
  }),
}));

vi.mock('@/retained-adapters/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/retained-adapters/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
}));

vi.mock('@/retained/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({
    showBilling: !state.billingHidden,
    hideBilling: state.billingHidden,
    isReady: true,
  }),
}));

vi.mock('@/retained/stores/useSocketStore', () => ({
  useSocketStore: (selector: (s: { socket: null; connect: () => void }) => unknown) =>
    selector({ socket: null, connect: () => {} }),
}));

vi.mock('@/retained/components/billing/BuyCreditsButton', async () => {
  const { createElement } = await import('react');
  return {
    BuyCreditsButton: () => createElement('button', { type: 'button' }, 'Buy credits'),
  };
});

vi.mock('@/retained/components/billing/UpgradeTierButton', () => ({
  UpgradeTierButton: () => null,
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix measures its switches and progress bars with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const patchMock = vi.mocked(patch);

beforeEach(() => {
  vi.clearAllMocks();
  state.billingHidden = false;
  state.query = '';
  patchMock.mockResolvedValue({ pulse: { enabled: false }, memory: { enabled: false, available: false } } as never);
  Object.assign(fixtures, {
    '/api/credits': {
      billingEnabled: true,
      monthly: { remaining: 900, allowance: 1500, periodEnd: '2026-11-03T12:00:00Z' },
      topup: { remaining: 0 },
      debt: 0,
      spendable: 900,
      reserved: 0,
      subscriptionTier: 'pro',
    },
    '/api/credits/breakdown': {
      periodStart: '2026-10-03T12:00:00Z',
      periodEnd: '2026-11-03T12:00:00Z',
      totalSpendCents: 2800,
      byFeature: [{ source: 'chat', label: 'Chat', spendCents: 2000, tokens: 1200, calls: 4, sharePct: 71 }],
      byModel: [{ model: 'model-x', provider: 'OpenAI', spendCents: 800, tokens: 900, calls: 2, sharePct: 29 }],
      byAgentSession: [{ pageId: 'p1', label: 'Sandbox A', activeSeconds: 120, spendCents: 500, calls: 3, sharePct: 18 }],
      byEnvironment: [{ envId: 'e1', label: 'Workspace env', spendCents: 600, calls: 1, sharePct: 21 }],
    },
    '/api/credits/concurrency': { inFlightHolds: { count: 1, limit: 4 }, codeExecutionLimit: 2 },
    '/api/settings/automations': { pulse: { enabled: true }, memory: { enabled: false, available: false } },
    '/api/storage/info': { quota: { formattedUsed: '311MB', formattedQuota: '2GB' } },
  });
});

afterEach(() => {
  cleanup();
});

describe('UsagePage (/account/usage)', () => {
  test('renders the balance as whole credits with the monthly progress bar', () => {
    render(<UsagePage />);
    const bar = screen.getByRole('progressbar', { name: 'Monthly credits used' });
    assert({
      given: 'a Pro balance of 90 of 150 monthly credits left',
      should: 'show the left and allowance as whole credits and the used portion on the progress bar',
      actual: {
        balance: screen.getByText('/ 150 credits').previousElementSibling?.textContent,
        used: screen.getByText('60 of 150 used', { exact: false }) !== null,
        bar: bar.tagName,
      },
      expected: { balance: '90', used: true, bar: 'DIV' },
    });
  });

  test('offers Buy credits only while billing is enabled', () => {
    const { unmount } = render(<UsagePage />);
    const shown = screen.queryByRole('button', { name: 'Buy credits' }) !== null;
    unmount();
    state.billingHidden = true;
    render(<UsagePage />);
    assert({
      given: 'billing on, then billing off',
      should: 'show Buy credits only when billing is enabled',
      actual: { on: shown, off: screen.queryByRole('button', { name: 'Buy credits' }) !== null },
      expected: { on: true, off: false },
    });
  });

  test('breaks the spend down by feature and by model', () => {
    render(<UsagePage />);
    assert({
      given: 'a period with chat and model spend',
      should: 'list the feature and model rows under By feature and By model',
      actual: {
        feature: screen.getByText('By feature') !== null && screen.getByText('Chat') !== null,
        model: screen.getByText('By model') !== null && screen.getByText('model-x') !== null,
      },
      expected: { feature: true, model: true },
    });
  });

  test('lists agent sandboxes with runtime, calls and credits, plus environments and in-flight calls', () => {
    render(<UsagePage />);
    const table = screen.getByRole('table');
    assert({
      given: 'one agent sandbox, one stored environment and one in-flight call',
      should: 'render the sandbox table, the environment and the in-flight count',
      actual: {
        headers: within(table).getAllByRole('columnheader').map((th) => th.textContent),
        row: within(table).getByText('Sandbox A').closest('tr')?.textContent,
        environment: screen.getByText('Workspace env') !== null,
        inFlight: screen.getByText('1 / 4') !== null,
      },
      expected: {
        headers: ['Agent', 'Runtime', 'Calls', 'Credits'],
        row: 'Sandbox A2m350',
        environment: true,
        inFlight: true,
      },
    });
  });

  test('shows the Pulse switch on and locks Memory on the free tier', () => {
    render(<UsagePage />);
    assert({
      given: 'Pulse enabled and Memory unavailable',
      should: 'render Pulse checked and Memory as a disabled switch',
      actual: {
        pulse: screen.getByRole('switch', { name: 'Pulse' }).getAttribute('aria-checked'),
        memory: screen.getByRole('switch', { name: 'Memory (upgrade required)' }).hasAttribute('disabled'),
      },
      expected: { pulse: 'true', memory: true },
    });
  });

  test('saves the automation toggle through /api/settings/automations', async () => {
    render(<UsagePage />);
    fireEvent.click(screen.getByRole('switch', { name: 'Pulse' }));
    await waitFor(() => {
      assert({
        given: 'Pulse switched off',
        should: 'patch pulseEnabled to false',
        actual: patchMock.mock.calls[0],
        expected: ['/api/settings/automations', { pulseEnabled: false }],
      });
    });
  });

  test('links the storage row to the storage screen with the used and total space', () => {
    render(<UsagePage />);
    const link = screen.getByRole('link', { name: 'Details →' });
    assert({
      given: 'a storage summary of 311MB of 2GB',
      should: 'show the used and total space and link to /account/storage',
      actual: { text: screen.getByText('311MB of 2GB used', { exact: false }) !== null, href: link.getAttribute('href') },
      expected: { text: true, href: '/account/storage' },
    });
  });

  test('says a canceled credit purchase was canceled', () => {
    state.query = 'credits=canceled';
    render(<UsagePage />);
    assert({
      given: 'a return from a canceled credit purchase with billing on',
      should: 'say the purchase was canceled and can be retried',
      actual: screen.queryByText(/Credit purchase canceled/) !== null,
      expected: true,
    });
  });

  test('confirms a credit purchase that succeeded', () => {
    state.query = 'credits=success';
    render(<UsagePage />);
    assert({
      given: 'a return from a successful credit purchase with billing on',
      should: 'confirm the top-up',
      actual: screen.queryByText(/Credits added!/) !== null,
      expected: true,
    });
  });
});

test('Usage always exposes the native wallet directory, including when billing controls are hidden', () => {
  state.billingHidden = true;
  render(<UsagePage />);
  expect(screen.getByRole('link', { name: 'Wallets' }).getAttribute('href')).toBe('/account/wallets');
});

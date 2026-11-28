// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import useSWR from 'swr';
import { ImagoSWRProvider, shouldRetryOnError } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { mount, unmountAll } from '@/ui/test-support/dom';

vi.mock('@/retained/stores/useSocketStore', () => ({
  useSocketStore: (select: (store: { socket: null; connect: () => Promise<void> }) => unknown) => select({ socket: null, connect: async () => {} }),
}));

const { useCreditBalance } = await import('./useCreditBalance');

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

function Probe() {
  const { balance, isError } = useCreditBalance();
  return h('output', null, isError ? 'error' : balance === undefined ? 'loading' : String(balance.spendable));
}

afterEach(unmountAll);

describe('useCreditBalance() in imago', () => {
  test('reads /api/credits through imago’s API client', async () => {
    const fake = fakeWeb({ 'GET /api/credits': () => Response.json({ billingEnabled: true, spendable: 6120 }) });
    const view = mount(<ImagoSWRProvider client={fake.client}><Probe /></ImagoSWRProvider>);
    await settle(() => {
      if (view.textContent !== '6120') throw new Error('not loaded');
    });

    assert({
      given: 'the shared SWR provider',
      should: 'load the balance with the provider’s fetcher, once',
      actual: [view.textContent, fake.count('GET /api/credits')],
      expected: ['6120', 1],
    });
  });

  test('a client error is not retried', async () => {
    const fake = fakeWeb({ 'GET /api/credits': () => Response.json({ error: 'Forbidden' }, { status: 403 }) });
    const seen: { error: unknown } = { error: undefined };
    function ErrorProbe() {
      seen.error = useSWR('/api/credits').error;
      return h(Probe);
    }
    const view = mount(<ImagoSWRProvider client={fake.client}><ErrorProbe /></ImagoSWRProvider>);
    await settle(() => {
      if (view.textContent !== 'error') throw new Error('no error yet');
    });

    assert({
      given: 'a 403 from /api/credits',
      should: 'fail with imago’s typed ApiError, which the provider does not retry (it would retry a plain Error forever)',
      actual: [seen.error instanceof ApiError && seen.error.status, seen.error instanceof Error && shouldRetryOnError(seen.error)],
      expected: [403, false],
    });
  });
});

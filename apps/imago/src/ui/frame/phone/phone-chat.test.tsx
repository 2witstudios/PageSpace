// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { phoneDocBodyClass } from './phone-doc-class';
import { PhoneAsk } from './phone-ask';
import { PhoneChatBack } from './phone-chat-back';
import { PhoneOpenPages } from './phone-open-pages';
import { newTab } from '../tabs/tabs-model';

vi.mock('next/navigation', () => ({ usePathname: () => '/d1/files/plan', useRouter: () => ({ push: () => {} }) }));

afterEach(unmountAll);

const client = createApiClient({
  fetch: async (input) =>
    Response.json(new URL(input, 'http://x').pathname === '/api/pages/plan' ? { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT' } : {}, { status: 200 }),
  navigate: () => {},
  location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/d1' }),
});

describe('PhoneAsk', () => {
  test('a link to the drive chat over the tree, a button over a page', () => {
    let pressed = 0;
    const link = mount(<PhoneAsk href="/d1" />);
    const button = mount(<PhoneAsk onPress={() => (pressed += 1)} />);
    act(() => button.querySelector('button')?.click());
    assert({
      given: 'Ask with a href and Ask with an action',
      should: 'link the first and act on the second',
      actual: [link.querySelector('a')?.getAttribute('href'), link.textContent, button.querySelector('a'), button.textContent, pressed],
      expected: ['/d1', 'Ask', null, 'Ask', 1],
    });
  });
});

describe('PhoneChatBack (IMC-11.4)', () => {
  test('"Back to {page}" once the page is known, "Back to page" before', async () => {
    let backs = 0;
    const view = mount(
      <ImagoSWRProvider client={client}>
        <PhoneChatBack pageId="plan" onBack={() => (backs += 1)} />
      </ImagoSWRProvider>,
    );
    const first = view.querySelector('button')?.getAttribute('aria-label');
    await act(() =>
      vi.waitFor(
        () => {
          if (view.querySelector('button')?.getAttribute('aria-label') === 'Back to page') throw new Error('page not loaded');
        },
        { timeout: 1000, interval: 5 },
      ),
    );
    act(() => view.querySelector('button')?.click());
    assert({
      given: 'the page loading',
      should: 'name the page in Back and call back when pressed',
      actual: [first, view.querySelector('button')?.getAttribute('aria-label'), backs],
      expected: ['Back to page', 'Back to Q4 Launch Plan', 1],
    });
  });
});

describe('the phone page body (IMC-11.3)', () => {
  test('uses the utility that scrolls the Formatting toolbar sideways with 38px tools', () => {
    assert({
      given: 'the phone page body',
      should: 'carry the phone-doc-body utility',
      actual: phoneDocBodyClass.split(' ').includes('phone-doc-body'),
      expected: true,
    });
  });
});

describe('PhoneOpenPages rows', () => {
  test('a DM and a settings screen get plain titles', () => {
    const view = mount(
      <ImagoSWRProvider client={client}>
        <PhoneOpenPages
          open={{
            tabs: [newTab('t1', '/dm/c1'), newTab('t2', '/d1/settings/general')],
            activeId: 't1',
            pathname: '/dm/c1',
            isCurrent: (tab) => tab.id === 't1',
            select: () => {},
            close: () => {},
            closeAll: () => {},
          }}
          onDismiss={() => {}}
        />
      </ImagoSWRProvider>,
    );
    assert({
      given: 'a conversation tab and a settings tab',
      should: 'list "Direct message" and the settings screen name',
      actual: [...view.querySelectorAll('[data-tab-path]')].map((row) => row.textContent),
      expected: ['Direct message', 'General'],
    });
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeRealtime } from '../../test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { conversation } from '../message-model/fixtures';
import type { ConversationResponse } from '../message-model/message';
import { messagePaths } from '../messages-api/messages-api';
import { ConversationObject } from './conversation-object';

afterEach(unmountAll);

const CONVERSATIONS = `GET ${messagePaths.conversations()}`;

const dms =
  (rows: readonly ConversationResponse[]): FakeRoute =>
  () =>
    Response.json({ conversations: rows, pagination: { hasMore: false, nextCursor: null, limit: 100 } });

const show = (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={fakeRealtime().client}>
        <ConversationObject conversationId="m1">
          <p data-conversation-content="">the conversation</p>
        </ConversationObject>
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

describe('ConversationObject', () => {
  test('one of the viewer’s conversations', async () => {
    const { container } = show({ [CONVERSATIONS]: dms([conversation('m1')]) });
    await settle(() => {
      if (!container.querySelector('[data-conversation-content]')) throw new Error('not shown');
    });
    assert({
      given: 'a conversation the viewer is part of',
      should: 'show the object’s content',
      actual: container.textContent,
      expected: 'the conversation',
    });
  });

  test('an id the viewer is not part of', async () => {
    const { container } = show({ [CONVERSATIONS]: dms([conversation('m2')]) });
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('no not-found');
    });
    const object = container.querySelector('[data-not-found]');
    assert({
      given: 'a conversation id the viewer’s DMs do not include',
      should: 'draw the not-found object with a way back to Messages',
      actual: [object?.querySelector('h2')?.textContent, object?.querySelector('a')?.getAttribute('href'), container.querySelector('[data-conversation-content]')],
      expected: ['Conversation not found', '/dm', null],
    });
  });

  test('DMs that will not load, then load', async () => {
    let calls = 0;
    const { container, web } = show({
      [CONVERSATIONS]: (request) => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'Unavailable' }, { status: 503 }) : dms([conversation('m1')])(request);
      },
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"] button')) throw new Error('no retry');
    });
    const title = container.querySelector('[role="alert"] h2')?.textContent;
    click(container.querySelector('[role="alert"] button') as HTMLButtonElement);
    await settle(() => {
      if (!container.querySelector('[data-conversation-content]')) throw new Error('not reloaded');
    });
    assert({
      given: 'a failed load, then Try again',
      should: 'draw the retryable error, then the conversation SWR loads on retry',
      actual: [title, web.count(CONVERSATIONS)],
      expected: ['Could not load this conversation', 2],
    });
  });
});

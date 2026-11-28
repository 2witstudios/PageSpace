// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

const resolved = vi.hoisted(() => ({
  current: { agent: null as { id: string } | null, isLoading: false, error: undefined as Error | undefined, retry: () => {} },
}));
vi.mock('../useResolvedAgent', () => ({ useResolvedAgent: () => resolved.current }));
vi.mock('../chat/SessionChat', () => ({ default: () => <div data-chat="" /> }));
vi.mock('../chat/AssistantSessionChat', () => ({ default: () => <div data-assistant="" /> }));

const { default: PaneChat } = await import('./PaneChat');

const pane = () => mount(<PaneChat sessionId="s1" conversationId="c1" agentPageId="agent-1" driveId="d1" />);

beforeEach(() => {
  resolved.current = { agent: null, isLoading: false, error: undefined, retry: () => {} };
});
afterEach(unmountAll);

describe('PaneChat', () => {
  test('an agent that will not resolve says so and offers Retry, instead of spinning', () => {
    const retry = vi.fn();
    resolved.current = { agent: null, isLoading: false, error: new Error('Request failed (403)'), retry };
    const root = pane();
    act(() => root.querySelector<HTMLButtonElement>('button')?.click());
    assert({
      given: "an agent page the viewer can't load",
      should: 'name the failure, offer Retry that asks again, and render no chat',
      actual: [root.querySelector('[role="alert"]')?.textContent?.includes("Couldn't open this agent"), retry.mock.calls.length, root.querySelector('[data-chat]')],
      expected: [true, 1, null],
    });
  });

  test('still loading shows the spinner, and a resolved agent its chat', () => {
    resolved.current = { ...resolved.current, isLoading: true };
    const loading = pane().querySelector('[role="alert"]');
    unmountAll();
    resolved.current = { agent: { id: 'agent-1' }, isLoading: false, error: undefined, retry: () => {} };
    assert({
      given: 'a loading agent, then a resolved one',
      should: 'show no failure while loading, then the chat',
      actual: [loading, pane().querySelector('[data-chat]') !== null],
      expected: [null, true],
    });
  });
});

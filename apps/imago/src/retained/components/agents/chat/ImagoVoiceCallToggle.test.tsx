// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import type { VoiceTarget } from '@/retained/lib/ai/realtime/voice-target';
import { ImagoVoiceCallToggle } from './ImagoVoiceCallToggle';

const session = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn<(target: VoiceTarget) => Promise<void>>(async () => {}),
  stop: vi.fn(),
}));

vi.mock('@/retained/contexts/VoiceSessionContext', () => ({
  useVoiceSession: () => session.state,
  useVoiceSessionControls: () => ({ start: session.start, stop: session.stop }),
}));

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const idle = { status: 'idle', error: undefined, failure: undefined, attached: false, target: null };
const onThisConversation: VoiceTarget = { conversationId: 'c-1', type: 'page', contextId: 'a-1', agentPageId: 'a-1' };

const button = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label="Voice call"]');

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'cloud');
  session.state = { ...idle };
  session.start.mockClear();
  session.stop.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllEnvs();
});

describe('ImagoVoiceCallToggle', () => {
  test('the unpressed toggle when no call is up', () => {
    const container = mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    assert({
      given: 'no call running',
      should: 'render a Voice call button that is not pressed',
      actual: button(container)?.getAttribute('aria-pressed'),
      expected: 'false',
    });
  });

  test('pressing starts a call on this conversation', () => {
    const container = mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    click(button(container)!);
    assert({
      given: 'the toggle pressed with nothing running',
      should: 'start a voice call bound to this conversation through the agent page',
      actual: session.start.mock.calls[0]?.[0],
      expected: onThisConversation,
    });
  });

  test('pressed while a call is live on this conversation', () => {
    session.state = { ...idle, status: 'connected', attached: true, target: onThisConversation };
    const container = mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    assert({
      given: 'a live call bound to this conversation',
      should: 'mark the toggle pressed',
      actual: button(container)?.getAttribute('aria-pressed'),
      expected: 'true',
    });
  });

  test('pressing while live ends the call', () => {
    session.state = { ...idle, status: 'connected', attached: true, target: onThisConversation };
    const container = mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    click(button(container)!);
    assert({
      given: 'a live call on this conversation',
      should: 'end it and not start another',
      actual: [session.stop.mock.calls.length, session.start.mock.calls.length],
      expected: [1, 0],
    });
  });

  test('a live call on another conversation', () => {
    session.state = { ...idle, status: 'connected', attached: true, target: { ...onThisConversation, conversationId: 'c-other' } };
    const container = mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    assert({
      given: 'a call live on a different conversation',
      should: 'not show this conversation as pressed',
      actual: button(container)?.getAttribute('aria-pressed'),
      expected: 'false',
    });
  });

  test('a session error is surfaced as a toast', () => {
    session.state = { ...idle, status: 'error', error: 'Microphone access was refused.', failure: 'mic-denied', target: null };
    mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    assert({
      given: 'the session failed to start',
      should: 'show the session\'s own sentence',
      actual: toast.error.mock.calls[0]?.[0],
      expected: 'Microphone access was refused.',
    });
  });

  test('hidden on-prem', () => {
    vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'onprem');
    const container = mount(<ImagoVoiceCallToggle agentId="a-1" conversationId="c-1" />);
    assert({
      given: 'an on-prem deployment',
      should: 'render no voice toggle',
      actual: button(container),
      expected: null,
    });
  });
});

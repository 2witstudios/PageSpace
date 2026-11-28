// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { mount, unmountAll } from '../../test-support/dom';
import { ChipsRow, chipsRowClass } from './chips-row';

const display = vi.hoisted(() => ({ showTokenCounts: true }));
vi.mock('@/retained/hooks/useDisplayPreferences', () => ({ useDisplayPreferences: () => ({ preferences: display }) }));

const rendered = vi.hoisted(() => ({ messages: [] as UIMessage[] }));
const calls = vi.hoisted(() => ({
  plan: [] as unknown[],
  tasks: [] as unknown[],
  usage: [] as unknown[],
  streams: [] as unknown[],
}));

vi.mock('@/retained/components/ai/shared/PlanChip', () => ({
  PlanChip: (props: unknown) => {
    calls.plan.push(props);
    return null;
  },
}));
vi.mock('@/retained/components/ai/shared/TasksDropdown', () => ({
  TasksDropdown: (props: unknown) => {
    calls.tasks.push(props);
    return null;
  },
}));
vi.mock('@/retained/components/ai/shared/AiUsageMonitor', () => ({
  AiUsageMonitor: (props: unknown) => {
    calls.usage.push(props);
    return null;
  },
}));
vi.mock('@/retained/hooks/useRenderedMessages', () => ({
  useRenderedMessages: (pageId: string, conversationId: string | null) => {
    calls.streams.push([pageId, conversationId]);
    return rendered.messages.map((message) => ({ message }));
  },
}));
vi.mock('@/retained-adapters/retained-provider', () => ({
  RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  unmountAll();
  display.showTokenCounts = true;
  calls.plan.length = 0;
  calls.tasks.length = 0;
  calls.usage.length = 0;
  calls.streams.length = 0;
});

describe('ChipsRow', () => {
  test('renders the three retained chips with the conversation and its messages', () => {
    const message = { id: 'm-1', role: 'assistant', parts: [] } as UIMessage;
    rendered.messages = [message];
    mount(<ChipsRow conversationId="c-1" agentId="a-1" driveId="d-1" />);
    assert({
      given: 'a conversation on agent a-1 with one message',
      should: 'pass the conversation and its messages to the plan and tasks chips, and the conversation to a compact usage readout that fits the 28px row',
      actual: {
        plan: calls.plan,
        tasks: calls.tasks,
        usage: calls.usage,
        streams: calls.streams,
      },
      expected: {
        plan: [{ conversationId: 'c-1', messages: [message] }],
        tasks: [{ messages: [message], driveId: 'd-1' }],
        usage: [{ conversationId: 'c-1', compact: true }],
        streams: [['a-1', 'c-1']],
      },
    });
  });

  test('does not mount context and cost usage when token counts are disabled', () => {
    display.showTokenCounts = false;
    mount(<ChipsRow conversationId="c-1" agentId="a-1" />);
    assert({ given: 'token counts disabled in display settings', should: 'omit the usage monitor', actual: calls.usage, expected: [] });
  });

  test('keeps the row collapsible', () => {
    rendered.messages = [];
    const container = mount(<ChipsRow conversationId={null} agentId={null} />);
    assert({
      given: 'no conversation, so no chip has anything to show',
      should: 'render the 28px row with the empty-hides class',
      actual: container.firstElementChild?.className,
      expected: chipsRowClass,
    });
  });
});

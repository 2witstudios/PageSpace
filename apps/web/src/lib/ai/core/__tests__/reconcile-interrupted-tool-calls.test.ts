import { describe, it } from 'vitest';
import type { ModelMessage, ToolModelMessage } from 'ai';
import { assert } from './riteway';
import { reconcileInterruptedToolCalls } from '../reconcile-interrupted-tool-calls';

const toolResultMsg = (toolCallId: string, toolName: string): ToolModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'json', value: { ok: true } } }],
});

describe('reconcileInterruptedToolCalls', () => {
  it('leaves a fully-resolved conversation unchanged in length', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'search', input: {} }] },
      toolResultMsg('a', 'search'),
    ];
    assert({
      given: 'every tool call already has a result',
      should: 'not inject any synthetic messages',
      actual: reconcileInterruptedToolCalls(messages).length,
      expected: 3,
    });
  });

  it('injects a synthetic interrupted result for a dangling tool call', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'create_page', input: {} }] },
    ];
    const out = reconcileInterruptedToolCalls(messages);
    const injected = out[1] as ToolModelMessage;
    assert({
      given: 'an assistant tool call with no following result (stream dropped mid-tool)',
      should: 'append a tool message resolving exactly that call id',
      actual: {
        length: out.length,
        role: injected.role,
        toolCallId: injected.content[0]?.toolCallId,
        interrupted: (injected.content[0]?.output as { type: string; value: { interrupted?: boolean } })
          .value.interrupted,
      },
      expected: { length: 2, role: 'tool', toolCallId: 'x', interrupted: true },
    });
  });

  it('does not re-run completed tools — only the dangling one is synthesized', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'search', input: {} }] },
      toolResultMsg('a', 'search'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'b', toolName: 'create_page', input: {} }] },
    ];
    const out = reconcileInterruptedToolCalls(messages);
    const injected = out[3] as ToolModelMessage;
    assert({
      given: 'one resolved tool call and one dangling call',
      should: 'synthesize only the dangling call, preserving the resolved one',
      actual: { length: out.length, injectedFor: injected?.content[0]?.toolCallId },
      expected: { length: 4, injectedFor: 'b' },
    });
  });
});

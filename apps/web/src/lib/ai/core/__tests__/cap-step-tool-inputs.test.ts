import { describe, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { assert } from '@/lib/ai/tools/__tests__/riteway';
import { capStepToolInputs, TOOL_INPUT_MAX_CHARS } from '../cap-step-tool-inputs';

/** An assistant tool call whose serialized arguments are `chars` long-ish. */
function toolCall(id: string, payloadChars: number) {
  return {
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'execute_tool',
    input: { tool_name: 'edit_sheet_cells', blob: 'x'.repeat(payloadChars) },
  };
}

function toolResult(id: string) {
  return {
    type: 'tool-result' as const,
    toolCallId: id,
    toolName: 'execute_tool',
    output: { type: 'json' as const, value: { ok: true } },
  };
}

/** N executed steps, each an oversized call followed by its result. */
function transcript(callCount: number, payloadChars: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'apply every chunk' }];
  for (let i = 0; i < callCount; i++) {
    messages.push({ role: 'assistant', content: [toolCall(`call-${i}`, payloadChars)] });
    messages.push({ role: 'tool', content: [toolResult(`call-${i}`)] });
  }
  return messages;
}

const OVERSIZED = TOOL_INPUT_MAX_CHARS * 2;

function inputsOf(messages: ModelMessage[]): unknown[] {
  return messages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m) => (m.content as { type: string; input?: unknown }[]))
    .filter((p) => p.type === 'tool-call')
    .map((p) => p.input);
}

function isCapped(input: unknown): boolean {
  return (
    typeof input === 'object' && input !== null && '__arguments_elided' in (input as object)
  );
}

describe('capStepToolInputs', () => {
  it('caps oversized arguments from already-executed steps', () => {
    const capped = capStepToolInputs(transcript(4, OVERSIZED));

    assert({
      given: 'four executed steps whose arguments each exceed the ceiling',
      should: 'cap every one of them except the newest',
      actual: inputsOf(capped).map(isCapped),
      expected: [true, true, true, false],
    });
  });

  it('never caps the newest tool call', () => {
    const capped = capStepToolInputs(transcript(3, OVERSIZED));
    const inputs = inputsOf(capped);

    assert({
      given: 'a transcript whose most recent call is oversized',
      should: 'leave the step the model just took fully intact',
      actual: inputs[inputs.length - 1],
      expected: transcript(3, OVERSIZED).length > 0
        ? { tool_name: 'edit_sheet_cells', blob: 'x'.repeat(OVERSIZED) }
        : null,
    });
  });

  it('leaves ordinary payloads alone, array reference included', () => {
    const original = transcript(5, 100);
    const capped = capStepToolInputs(original);

    assert({
      given: 'a transcript of ordinary-sized writes',
      should: 'return the very same array — nothing copied, nothing rewritten',
      actual: capped === original,
      expected: true,
    });
  });

  it('does not mutate the messages it is given', () => {
    const original = transcript(3, OVERSIZED);
    const before = JSON.stringify(original);
    capStepToolInputs(original);

    assert({
      given: 'a transcript that needs capping',
      should: 'leave the caller\'s array untouched',
      actual: JSON.stringify(original) === before,
      expected: true,
    });
  });

  it('keeps the capped argument value an object', () => {
    // Providers model tool arguments as a JSON object. Replacing the payload
    // with a bare string is a shape change the call/result pairing does not
    // survive everywhere, so the stub has to stay an object.
    const capped = capStepToolInputs(transcript(2, OVERSIZED));
    const oldest = inputsOf(capped)[0];

    assert({
      given: 'a capped argument payload',
      should: 'still be a non-null object, not a string',
      actual: typeof oldest === 'object' && oldest !== null && !Array.isArray(oldest),
      expected: true,
    });
  });

  it('is byte-stable once capped — recapping changes nothing further', () => {
    // Cache breakpoints depend on replayed bytes being stable. A message that
    // has been capped once must cap identically on every later step.
    const once = capStepToolInputs(transcript(4, OVERSIZED));
    const twice = capStepToolInputs(once);

    assert({
      given: 'an already-capped transcript passed through the cap a second time',
      should: 'produce byte-identical messages',
      actual: JSON.stringify(twice) === JSON.stringify(once),
      expected: true,
    });
  });

  it('preserves tool call ids and names so call/result pairing survives', () => {
    const capped = capStepToolInputs(transcript(3, OVERSIZED));
    const ids = capped
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as { toolCallId?: string; toolName?: string }[])
      .map((p) => `${p.toolCallId}:${p.toolName}`);

    assert({
      given: 'a capped transcript',
      should: 'keep every tool call id and name exactly as it was',
      actual: ids,
      expected: ['call-0:execute_tool', 'call-1:execute_tool', 'call-2:execute_tool'],
    });
  });

  it('bounds total transcript size instead of growing with every step', () => {
    // The measured #2461 shape: ~103 KB of arguments retained per step, dead
    // linear, for up to AGENT_MAX_STEPS. Capping has to break that slope.
    const uncapped = JSON.stringify(transcript(30, OVERSIZED)).length;
    const capped = JSON.stringify(capStepToolInputs(transcript(30, OVERSIZED))).length;

    assert({
      given: 'thirty oversized calls in a single agent loop',
      should: 'hold the replayed transcript to a small fraction of its raw size',
      actual: capped < uncapped / 10,
      expected: true,
    });
  });

  it('ignores non-assistant messages and string content', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'x'.repeat(OVERSIZED) },
      { role: 'user', content: 'y'.repeat(OVERSIZED) },
    ];

    assert({
      given: 'oversized system and user messages',
      should: 'leave them alone — only tool arguments are capped',
      actual: capStepToolInputs(messages) === messages,
      expected: true,
    });
  });
});

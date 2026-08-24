import { describe, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { assert } from '@/lib/ai/tools/__tests__/riteway';
import {
  capStepToolPayloads,
  KEEP_RECENT_TOOL_RESULTS,
  TOOL_PAYLOAD_MAX_CHARS,
} from '../cap-step-tool-payloads';

/** An assistant tool call whose serialized arguments are `chars` long-ish. */
function toolCall(id: string, payloadChars: number) {
  return {
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'execute_tool',
    input: { tool_name: 'edit_sheet_cells', blob: 'x'.repeat(payloadChars) },
  };
}

function toolResult(id: string, payloadChars = 0) {
  return {
    type: 'tool-result' as const,
    toolCallId: id,
    toolName: 'execute_tool',
    output: {
      type: 'json' as const,
      value: payloadChars > 0 ? { blob: 'r'.repeat(payloadChars) } : { ok: true },
    },
  };
}

/** N executed read steps, each returning an oversized result. */
function readTranscript(callCount: number, payloadChars: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'read every chunk' }];
  for (let i = 0; i < callCount; i++) {
    messages.push({ role: 'assistant', content: [toolCall(`call-${i}`, 10)] });
    messages.push({ role: 'tool', content: [toolResult(`call-${i}`, payloadChars)] });
  }
  return messages;
}

function outputsOf(messages: ModelMessage[]): unknown[] {
  return messages
    .filter((m) => m.role === 'tool' && Array.isArray(m.content))
    .flatMap((m) => m.content as { type: string; output?: { value?: unknown } }[])
    .filter((p) => p.type === 'tool-result')
    .map((p) => p.output?.value);
}

function isCappedOutput(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '__payload_elided' in (value as object);
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

const OVERSIZED = TOOL_PAYLOAD_MAX_CHARS * 2;

function inputsOf(messages: ModelMessage[]): unknown[] {
  return messages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m) => (m.content as { type: string; input?: unknown }[]))
    .filter((p) => p.type === 'tool-call')
    .map((p) => p.input);
}

function isCapped(input: unknown): boolean {
  return (
    typeof input === 'object' && input !== null && '__payload_elided' in (input as object)
  );
}

describe('capStepToolPayloads', () => {
  it('caps oversized arguments from already-executed steps', () => {
    const capped = capStepToolPayloads(transcript(4, OVERSIZED));

    assert({
      given: 'four executed steps whose arguments each exceed the ceiling',
      should: 'cap every one of them except the newest',
      actual: inputsOf(capped).map(isCapped),
      expected: [true, true, true, false],
    });
  });

  it('never caps the newest tool call', () => {
    const capped = capStepToolPayloads(transcript(3, OVERSIZED));
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
    const capped = capStepToolPayloads(original);

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
    capStepToolPayloads(original);

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
    const capped = capStepToolPayloads(transcript(2, OVERSIZED));
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
    const once = capStepToolPayloads(transcript(4, OVERSIZED));
    const twice = capStepToolPayloads(once);

    assert({
      given: 'an already-capped transcript passed through the cap a second time',
      should: 'produce byte-identical messages',
      actual: JSON.stringify(twice) === JSON.stringify(once),
      expected: true,
    });
  });

  it('preserves tool call ids and names so call/result pairing survives', () => {
    const capped = capStepToolPayloads(transcript(3, OVERSIZED));
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
    const capped = JSON.stringify(capStepToolPayloads(transcript(30, OVERSIZED))).length;

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
      actual: capStepToolPayloads(messages) === messages,
      expected: true,
    });
  });
});

describe('capStepToolPayloads — tool results', () => {
  it('caps oversized results from steps outside the retention window', () => {
    const capped = capStepToolPayloads(readTranscript(6, OVERSIZED));
    const flags = outputsOf(capped).map(isCappedOutput);

    // Six results, the newest KEEP_RECENT_TOOL_RESULTS kept whole.
    assert({
      given: 'six executed reads whose results each exceed the ceiling',
      should: 'cap all but the most recent few',
      actual: flags,
      expected: [
        ...Array(6 - KEEP_RECENT_TOOL_RESULTS).fill(true),
        ...Array(KEEP_RECENT_TOOL_RESULTS).fill(false),
      ],
    });
  });

  it('keeps a gather-then-act agent whole', () => {
    // Reading three files before writing anything is normal. If the first read
    // were capped by the time the write happens, the agent loses what it was
    // about to act on — the whole reason results get a window and arguments do not.
    const capped = capStepToolPayloads(readTranscript(KEEP_RECENT_TOOL_RESULTS, OVERSIZED));

    assert({
      given: 'exactly as many reads as the retention window holds',
      should: 'leave every one of them intact',
      actual: outputsOf(capped).map(isCappedOutput),
      expected: Array(KEEP_RECENT_TOOL_RESULTS).fill(false),
    });
  });

  it('preserves the output type so a failure cannot read as a success', () => {
    // `error-text` tells the provider the tool failed. Rewriting it to `text`
    // while stubbing the value would silently turn a failure into a success.
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-err',
            toolName: 'execute_tool',
            output: { type: 'error-text', value: 'x'.repeat(OVERSIZED) },
          },
        ],
      },
      ...readTranscript(KEEP_RECENT_TOOL_RESULTS, 10).slice(1),
    ];
    const capped = capStepToolPayloads(messages);
    const errPart = (capped[1].content as { output: { type: string; value: unknown } }[])[0];

    assert({
      given: 'an oversized error-text result that has fallen out of the window',
      should: 'stub the value but keep the error type',
      actual: { type: errPart.output.type, stubbed: typeof errPart.output.value === 'string' },
      expected: { type: 'error-text', stubbed: true },
    });
  });

  it('bounds a read-heavy loop instead of growing with every step', () => {
    // Measured on the real loop: results accumulate at ~+100 KB per step, the
    // same dead-linear shape arguments did. This is the reporter's other half —
    // they read ~30 JSON chunks before writing any of them.
    const uncapped = JSON.stringify(readTranscript(30, OVERSIZED)).length;
    const capped = JSON.stringify(capStepToolPayloads(readTranscript(30, OVERSIZED))).length;

    assert({
      given: 'thirty oversized reads in a single agent loop',
      should: 'hold the replayed transcript to a small fraction of its raw size',
      actual: capped < uncapped / 5,
      expected: true,
    });
  });

  it('leaves ordinary results alone, array reference included', () => {
    const original = readTranscript(8, 50);

    assert({
      given: 'a read-heavy loop over ordinary-sized results',
      should: 'return the very same array — nothing copied, nothing rewritten',
      actual: capStepToolPayloads(original) === original,
      expected: true,
    });
  });
});

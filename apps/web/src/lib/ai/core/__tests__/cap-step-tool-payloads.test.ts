import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { assert } from '@/lib/ai/tools/__tests__/riteway';
import {
  capStepToolPayloads,
  KEEP_RECENT_RESULT_STEPS,
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
      expected: { tool_name: 'edit_sheet_cells', blob: 'x'.repeat(OVERSIZED) },
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

describe('capStepToolPayloads — parallel calls in one step', () => {
  it('keeps every call of the newest step, not just one of them', () => {
    // A step can issue several tool calls at once; they all land in a single
    // assistant message. Exempting by position would keep the last and cap its
    // siblings — an arbitrary line through what is really one step.
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [toolCall('old-a', OVERSIZED), toolCall('old-b', OVERSIZED)] },
      { role: 'tool', content: [toolResult('old-a'), toolResult('old-b')] },
      { role: 'assistant', content: [toolCall('new-a', OVERSIZED), toolCall('new-b', OVERSIZED), toolCall('new-c', OVERSIZED)] },
      { role: 'tool', content: [toolResult('new-a'), toolResult('new-b'), toolResult('new-c')] },
    ];

    assert({
      given: 'an older parallel step and a newest parallel step of three calls',
      should: 'cap the older step entirely and keep all three newest calls',
      actual: inputsOf(capStepToolPayloads(messages)).map(isCapped),
      expected: [true, true, false, false, false],
    });
  });
});

describe('capStepToolPayloads — parallel results in one step', () => {
  it('keeps every result of the newest step, however many it produced', () => {
    // One step can read four files at once and land four result parts in a
    // single tool message. Retaining the last N result PARTS would keep three of
    // those four and stub the rest — breaking exactly the gather-then-act agent
    // the retention window exists to protect. Retention is by step.
    const parallel = KEEP_RECENT_RESULT_STEPS + 1;
    const messages: ModelMessage[] = [
      { role: 'user', content: 'read them all' },
      {
        role: 'assistant',
        content: Array.from({ length: parallel }, (_, i) => toolCall(`p-${i}`, 10)),
      },
      {
        role: 'tool',
        content: Array.from({ length: parallel }, (_, i) => toolResult(`p-${i}`, OVERSIZED)),
      },
    ];

    assert({
      given: `a single newest step that produced ${parallel} oversized results in parallel`,
      should: 'keep all of them, not just the last few parts',
      actual: outputsOf(capStepToolPayloads(messages)).map(isCappedOutput),
      expected: Array(parallel).fill(false),
    });
  });

  it('still caps steps that have fallen out of the window', () => {
    // The window is steps, so it must still expire whole steps behind it.
    const steps = KEEP_RECENT_RESULT_STEPS + 2;
    const messages: ModelMessage[] = [{ role: 'user', content: 'read every chunk' }];
    for (let i = 0; i < steps; i++) {
      messages.push({ role: 'assistant', content: [toolCall(`s-${i}`, 10)] });
      messages.push({ role: 'tool', content: [toolResult(`s-${i}`, OVERSIZED)] });
    }

    assert({
      given: `${steps} sequential oversized reads with a ${KEEP_RECENT_RESULT_STEPS}-step window`,
      should: 'cap the two oldest steps and keep the rest',
      actual: outputsOf(capStepToolPayloads(messages)).map(isCappedOutput),
      expected: [true, true, ...Array(KEEP_RECENT_RESULT_STEPS).fill(false)],
    });
  });
});

describe('capStepToolPayloads — tool results', () => {
  it('caps oversized results from steps outside the retention window', () => {
    const capped = capStepToolPayloads(readTranscript(6, OVERSIZED));
    const flags = outputsOf(capped).map(isCappedOutput);

    // Six results, the newest KEEP_RECENT_RESULT_STEPS kept whole.
    assert({
      given: 'six executed reads whose results each exceed the ceiling',
      should: 'cap all but the most recent few',
      actual: flags,
      expected: [
        ...Array(6 - KEEP_RECENT_RESULT_STEPS).fill(true),
        ...Array(KEEP_RECENT_RESULT_STEPS).fill(false),
      ],
    });
  });

  it('keeps a gather-then-act agent whole', () => {
    // Reading three files before writing anything is normal. If the first read
    // were capped by the time the write happens, the agent loses what it was
    // about to act on — the whole reason results get a window and arguments do not.
    const capped = capStepToolPayloads(readTranscript(KEEP_RECENT_RESULT_STEPS, OVERSIZED));

    assert({
      given: 'exactly as many reads as the retention window holds',
      should: 'leave every one of them intact',
      actual: outputsOf(capped).map(isCappedOutput),
      expected: Array(KEEP_RECENT_RESULT_STEPS).fill(false),
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
      ...readTranscript(KEEP_RECENT_RESULT_STEPS, 10).slice(1),
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

describe('capStepToolPayloads — write-tool result stubs', () => {
  /** A stale result from a WRITE tool (e.g. replace_lines), not a read. */
  function writeTranscript(callCount: number, payloadChars: number): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'user', content: 'edit every chunk' }];
    for (let i = 0; i < callCount; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `w-${i}`, toolName: 'replace_lines', input: { startLine: 1 } }],
      });
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `w-${i}`,
          toolName: 'replace_lines',
          output: { type: 'json', value: { blob: 'r'.repeat(payloadChars) } },
        }],
      });
    }
    return messages;
  }

  it('tells the model a stale WRITE result already succeeded, not to re-run it', () => {
    const capped = capStepToolPayloads(writeTranscript(6, OVERSIZED));
    const stubbed = outputsOf(capped).find(isCappedOutput) as { __payload_elided: string };

    assert({
      given: 'a stale result from a WRITE tool that has fallen out of the window',
      should: 'advise a fresh read, and explicitly say not to re-run the call',
      actual: {
        saysAlreadySucceeded: stubbed.__payload_elided.includes('already succeeded'),
        saysDoNotReRun: stubbed.__payload_elided.toLowerCase().includes('must not be re-run'.toLowerCase()),
        saysCallItAgain: stubbed.__payload_elided.includes('call it again with the same arguments'),
      },
      expected: { saysAlreadySucceeded: true, saysDoNotReRun: true, saysCallItAgain: false },
    });
  });

  it('keeps the re-run advice for a stale result from a READ tool dispatched top-level', () => {
    // readTranscript's toolName is 'execute_tool' with a nested tool_name of
    // 'edit_sheet_cells' — itself a WRITE tool (see the dispatcher-resolution
    // tests below). This test is about the outer-name-only path: a result
    // whose outer name plainly isn't a write tool keeps the read-style advice.
    const capped = capStepToolPayloads(readTranscript(6, OVERSIZED));
    const stubbed = outputsOf(capped).find(isCappedOutput) as { __payload_elided: string };

    assert({
      given: 'a stale result whose nested tool_name resolves to a write tool',
      should: 'now say the call already succeeded — dispatcher resolution reclassified it',
      actual: stubbed.__payload_elided.includes('already succeeded'),
      expected: true,
    });
  });

  /** A genuinely READ tool dispatched via execute_tool, for contrast with the write case above. */
  function dispatchedReadTranscript(callCount: number, payloadChars: number): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'user', content: 'read every chunk' }];
    for (let i = 0; i < callCount; i++) {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: `r-${i}`,
          toolName: 'execute_tool',
          input: { tool_name: 'read_page', parameters: {} },
        }],
      });
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `r-${i}`,
          toolName: 'execute_tool',
          output: { type: 'json', value: { blob: 'r'.repeat(payloadChars) } },
        }],
      });
    }
    return messages;
  }

  it('keeps the re-run advice for a genuinely read tool dispatched via execute_tool', () => {
    const capped = capStepToolPayloads(dispatchedReadTranscript(6, OVERSIZED));
    const stubbed = outputsOf(capped).find(isCappedOutput) as { __payload_elided: string };

    assert({
      given: 'a stale result from read_page dispatched via execute_tool',
      should: 'keep advising the model to call it again if it still needs the result',
      actual: stubbed.__payload_elided.includes('call it again with the same arguments'),
      expected: true,
    });
  });

  /** A WRITE tool dispatched via the execute_tool wrapper (search-exposure mode). */
  function dispatchedWriteTranscript(callCount: number, payloadChars: number): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'user', content: 'edit every chunk' }];
    for (let i = 0; i < callCount; i++) {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: `d-${i}`,
          toolName: 'execute_tool',
          input: { tool_name: 'replace_lines', parameters: { startLine: 1 } },
        }],
      });
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `d-${i}`,
          toolName: 'execute_tool',
          output: { type: 'json', value: { blob: 'r'.repeat(payloadChars) } },
        }],
      });
    }
    return messages;
  }

  it('classifies a write dispatched through execute_tool as a write, not a read', () => {
    // toolExposureMode: 'search' routes non-core writes through execute_tool, so
    // the recorded outer toolName is 'execute_tool' — the real tool name is
    // nested in the paired call's `input.tool_name`. Judging by the outer name
    // alone would advise re-running a write that already happened.
    const capped = capStepToolPayloads(dispatchedWriteTranscript(6, OVERSIZED));
    const stubbed = outputsOf(capped).find(isCappedOutput) as { __payload_elided: string };

    assert({
      given: 'a stale result from replace_lines dispatched via execute_tool',
      should: 'still say the call already succeeded and must not be re-run',
      actual: {
        saysAlreadySucceeded: stubbed.__payload_elided.includes('already succeeded'),
        saysCallItAgain: stubbed.__payload_elided.includes('call it again with the same arguments'),
      },
      expected: { saysAlreadySucceeded: true, saysCallItAgain: false },
    });
  });

  it('falls back to the dispatcher name when the paired call carries no tool_name', () => {
    // Defensive: a malformed/missing tool_name must not crash, and must not be
    // misread as some other write tool — the dispatcher name itself is not in
    // WRITE_TOOLS, so this degrades to ordinary read-style advice rather than
    // a false "already succeeded" claim.
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x-0', toolName: 'execute_tool', input: { parameters: {} } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x-0', toolName: 'execute_tool', output: { type: 'json', value: { blob: 'r'.repeat(OVERSIZED) } } }] },
      ...dispatchedWriteTranscript(KEEP_RECENT_RESULT_STEPS, 10).slice(1),
    ];

    expect(() => capStepToolPayloads(messages)).not.toThrow();

    const stubbed = outputsOf(capStepToolPayloads(messages)).find(isCappedOutput) as { __payload_elided: string };
    assert({
      given: 'a stale execute_tool result whose paired call has no tool_name',
      should: 'fall back to read-style advice rather than falsely claiming success',
      actual: stubbed.__payload_elided.includes('call it again with the same arguments'),
      expected: true,
    });
  });
});

describe('capStepToolPayloads — write-tool error results are not marked "succeeded"', () => {
  function writeErrorTranscript(callCount: number, payloadChars: number): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'user', content: 'edit every chunk' }];
    for (let i = 0; i < callCount; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `e-${i}`, toolName: 'replace_lines', input: { startLine: 1 } }],
      });
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `e-${i}`,
          toolName: 'replace_lines',
          output: { type: 'error-json', value: { error: 'x'.repeat(payloadChars) } },
        }],
      });
    }
    return messages;
  }

  it('never claims a failed write "already succeeded"', () => {
    const capped = capStepToolPayloads(writeErrorTranscript(6, OVERSIZED));
    const stubbed = outputsOf(capped).find(isCappedOutput) as { __payload_elided: string };

    assert({
      given: 'a stale error-json result from a WRITE tool that has fallen out of the window',
      should: 'give neutral wording instead of claiming the call already succeeded',
      actual: {
        saysAlreadySucceeded: stubbed.__payload_elided.includes('already succeeded'),
        saysDoNotAssumeSucceeded: stubbed.__payload_elided.includes('do not assume it succeeded'),
      },
      expected: { saysAlreadySucceeded: false, saysDoNotAssumeSucceeded: true },
    });
  });

  it('preserves the error-json output type on a write-tool failure', () => {
    const capped = capStepToolPayloads(writeErrorTranscript(6, OVERSIZED));
    const errPart = capped
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as { output: { type: string } }[])
      .find((p) => typeof p.output?.type === 'string');

    assert({
      given: 'a capped error-json result from a write tool',
      should: 'keep the error-json type so the provider still sees a failure',
      actual: errPart?.output.type,
      expected: 'error-json',
    });
  });
});

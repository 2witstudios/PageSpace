import { describe, test } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { toPtyInput, PTY_MAX_INPUT_BYTES } from './pty-input';

const bytesOf = (value: string) => new TextEncoder().encode(value).length;

describe('toPtyInput', () => {
  test('a one-line prompt is written, then submitted', () => {
    assert({
      given: 'a single-line starting prompt',
      should: 'write it and submit it once',
      actual: toPtyInput('fix the build'),
      expected: ['fix the build', '\r'],
    });
  });

  test('a multi-line prompt reaches the agent as ONE turn', () => {
    assert({
      given: 'a pasted two-line prompt (the textarea takes Shift+Enter newlines)',
      should:
        'collapse the newline — a newline in a tty IS a submit, so writing it verbatim would send the agent two turns, and a shell two commands',
      actual: toPtyInput('fix the build\nthen run the tests'),
      expected: ['fix the build then run the tests', '\r'],
    });
  });

  test('a prompt too big for one write is split instead of dropped', () => {
    const huge = 'x'.repeat(PTY_MAX_INPUT_BYTES * 2 + 17);

    const chunks = toPtyInput(huge);

    assert({
      given: 'a pasted spec larger than the bridge\'s MAX_INPUT_BYTES',
      should:
        'split it into writes that each fit — the bridge silently DROPS an oversized write whole, so one big emit would lose the prompt with no error',
      actual: {
        everyChunkFits: chunks.every((chunk) => bytesOf(chunk) <= PTY_MAX_INPUT_BYTES),
        rejoined: chunks.slice(0, -1).join(''),
        submitsOnce: chunks.filter((chunk) => chunk === '\r').length,
      },
      expected: { everyChunkFits: true, rejoined: huge, submitsOnce: 1 },
    });
  });

  test('a multi-byte character is never split across two writes', () => {
    // Each 🙂 is 4 UTF-8 bytes; a 6-byte cap must break between them, not inside one.
    const chunks = toPtyInput('🙂🙂🙂', 6);

    assert({
      given: 'emoji at a chunk boundary',
      should: 'split on code points — half a surrogate pair is an invalid write',
      actual: { chunks, rejoined: chunks.slice(0, -1).join('') },
      expected: { chunks: ['🙂', '🙂', '🙂', '\r'], rejoined: '🙂🙂🙂' },
    });
  });

  test('an empty prompt writes nothing at all', () => {
    assert({
      given: 'no starting prompt (the field is optional)',
      should: 'write nothing — not even a bare Enter, which would submit an empty turn to the agent',
      actual: [toPtyInput(''), toPtyInput('   \n  ')],
      expected: [[], []],
    });
  });
});

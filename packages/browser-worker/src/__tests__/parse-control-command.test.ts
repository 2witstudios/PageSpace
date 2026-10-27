import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { parseControlCommand } from '../parse-control-command.js';
import { BROWSER_OPERATION_LIMITS } from '../browser-operation.js';

describe('parseControlCommand', () => {
  it('accepts every typed operation in its exact shape', () => {
    const commands = [
      { type: 'operation', operation: { kind: 'navigate', url: 'https://example.com/' } },
      { type: 'operation', operation: { kind: 'click', ref: 'e12' } },
      { type: 'operation', operation: { kind: 'type', ref: 'f1e3', text: 'hello', submit: true } },
      { type: 'operation', operation: { kind: 'read' } },
      { type: 'operation', operation: { kind: 'screenshot' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'list' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'open', url: 'https://example.com/' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'select', tabId: 'tab-2' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'close', tabId: 'tab-2' } },
    ];
    assert({
      given: 'each typed operation',
      should: 'return it unchanged',
      actual: commands.map((c) => parseControlCommand(c)),
      expected: commands,
    });
  });

  it('accepts the human and server commands', () => {
    const commands = [
      { type: 'take-over' },
      { type: 'release' },
      { type: 'view-frame' },
      { type: 'audit' },
      { type: 'human-input', input: { kind: 'click', x: 10, y: 20.5 } },
      { type: 'human-input', input: { kind: 'text', text: 'typed by a person' } },
      { type: 'human-input', input: { kind: 'key', key: 'Enter' } },
    ];
    assert({
      given: 'take-over, release, view-frame, audit and each human input',
      should: 'return them unchanged',
      actual: commands.map((c) => parseControlCommand(c)),
      expected: commands,
    });
  });

  it('drops fields the typed shape does not declare', () => {
    assert({
      given: 'a click carrying an extra script field',
      should: 'return only the declared fields',
      actual: parseControlCommand({ type: 'operation', operation: { kind: 'click', ref: 'e1', script: 'document.cookie' }, extra: 1 }),
      expected: { type: 'operation', operation: { kind: 'click', ref: 'e1' } },
    });
  });

  it('refuses anything that is not a typed command', () => {
    const tooLongUrl = `https://example.com/${'a'.repeat(BROWSER_OPERATION_LIMITS.maxUrlLength)}`;
    const refused = [
      null,
      'navigate',
      [],
      { type: 'eval', script: '1+1' },
      { type: 'operation' },
      { type: 'operation', operation: null },
      { type: 'operation', operation: { kind: 'evaluate', expression: 'document.cookie' } },
      { type: 'operation', operation: { kind: 'cookies' } },
      { type: 'operation', operation: { kind: 'navigate' } },
      { type: 'operation', operation: { kind: 'navigate', url: 42 } },
      { type: 'operation', operation: { kind: 'navigate', url: tooLongUrl } },
      { type: 'operation', operation: { kind: 'click', ref: 'button.submit' } },
      { type: 'operation', operation: { kind: 'click', ref: '' } },
      { type: 'operation', operation: { kind: 'click', ref: 'e'.repeat(BROWSER_OPERATION_LIMITS.maxRefLength + 1) } },
      { type: 'operation', operation: { kind: 'type', ref: 'e1', text: 'x' } },
      { type: 'operation', operation: { kind: 'type', ref: 'e1', text: 'x'.repeat(BROWSER_OPERATION_LIMITS.maxTextLength + 1), submit: false } },
      { type: 'operation', operation: { kind: 'tabs' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'duplicate' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'select' } },
      { type: 'operation', operation: { kind: 'tabs', action: 'close', tabId: 'x'.repeat(BROWSER_OPERATION_LIMITS.maxTabIdLength + 1) } },
      { type: 'operation', operation: { kind: 'tabs', action: 'open' } },
      { type: 'human-input' },
      { type: 'human-input', input: { kind: 'click', x: Number.NaN, y: 1 } },
      { type: 'human-input', input: { kind: 'click', x: -1, y: 1 } },
      { type: 'human-input', input: { kind: 'click', x: 1 } },
      { type: 'human-input', input: { kind: 'text', text: 7 } },
      { type: 'human-input', input: { kind: 'key', key: 'F12' } },
      { type: 'human-input', input: { kind: 'paste' } },
    ];
    assert({
      given: 'untyped, unknown or out-of-bounds commands (eval, cookies, selectors, oversized text, bad coordinates, unlisted keys)',
      should: 'refuse each',
      actual: refused.map((c) => parseControlCommand(c)),
      expected: refused.map(() => null),
    });
  });
});

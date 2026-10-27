import { describe, it, expect } from 'vitest';
import { sheetTriggerPattern } from '../constants';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('sheetTriggerPattern', () => {
  it('allows a mention at the start of the input', () => {
    assert({
      given: 'an empty preceding string (start of input)',
      should: 'allow the @ trigger',
      actual: sheetTriggerPattern.test(''),
      expected: true,
    });
  });

  it('allows a mention after a formula operator', () => {
    assert({
      given: 'an = immediately before the trigger',
      should: 'allow the @ trigger',
      actual: sheetTriggerPattern.test('='),
      expected: true,
    });
  });

  it('allows a mention after an opening parenthesis', () => {
    assert({
      given: 'a ( immediately before the trigger',
      should: 'allow the @ trigger',
      actual: sheetTriggerPattern.test('('),
      expected: true,
    });
  });

  it('allows a mention after whitespace', () => {
    assert({
      given: 'a space immediately before the trigger',
      should: 'allow the @ trigger',
      actual: sheetTriggerPattern.test(' '),
      expected: true,
    });
  });

  it('rejects a mention immediately after a letter', () => {
    assert({
      given: 'a letter immediately before the trigger',
      should: 'not allow the @ trigger (mid-word)',
      actual: sheetTriggerPattern.test('a'),
      expected: false,
    });
  });

  it('rejects a mention immediately after a digit', () => {
    assert({
      given: 'a digit immediately before the trigger',
      should: 'not allow the @ trigger',
      actual: sheetTriggerPattern.test('5'),
      expected: false,
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { envBool, envFloat, envInt } from '../env-parse';

describe('env-parse — a typo never silently becomes a billing value', () => {
  afterEach(() => {
    delete process.env.ENV_PARSE_TEST_FLOAT;
  });

  it('envInt reads only an unsigned integer literal, else the default', () => {
    expect(envInt('N', 7, { N: ' 42 ' })).toBe(42);
    for (const raw of [undefined, '', '1.5', '-3', '100abc', ' ']) expect(envInt('N', 7, { N: raw })).toBe(7);
  });

  it('envBool reads the documented spellings either way, case-insensitively, and defaults on anything else', () => {
    for (const raw of ['true', 'TRUE', '1', 'yes', 'On']) expect(envBool('B', false, { B: raw })).toBe(true);
    for (const raw of ['false', '0', 'No', 'off']) expect(envBool('B', true, { B: raw })).toBe(false);
    for (const raw of [undefined, '', 'maybe']) expect(envBool('B', true, { B: raw })).toBe(true);
  });

  it('envFloat reads a non-negative finite number from the process env, else the default', () => {
    expect(envFloat('ENV_PARSE_TEST_FLOAT', 1.5)).toBe(1.5);
    for (const [raw, want] of [['0.25', 0.25], ['', 1.5], ['-1', 1.5], ['abc', 1.5], ['Infinity', 1.5]] as const) {
      process.env.ENV_PARSE_TEST_FLOAT = raw;
      expect(envFloat('ENV_PARSE_TEST_FLOAT', 1.5), raw).toBe(want);
    }
  });
});

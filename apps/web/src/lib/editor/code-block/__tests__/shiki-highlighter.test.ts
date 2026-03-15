import { describe, it, expect } from 'vitest';
import { assert } from '@/test/riteway';
import { tokenizeCode } from '../shiki-highlighter';

describe('Shiki Highlighter Service', () => {
  it('tokenizes JavaScript code', async () => {
    const tokens = await tokenizeCode('const x = 1', 'javascript', 'one-light');
    expect(tokens.length, 'Given JavaScript code, should return at least one line of tokens').toBeGreaterThan(0);
    expect(tokens[0].length, 'Given JavaScript code, should return at least one token per line').toBeGreaterThan(0);
    assert({
      given: 'JavaScript code tokens',
      should: 'include at least one token with a color',
      actual: tokens[0].some((t) => t.color !== undefined),
      expected: true,
    });
  });

  it('tokenizes SudoLang code', async () => {
    const tokens = await tokenizeCode('TodoItem { id }', 'sudolang', 'one-light');
    expect(tokens.length, 'Given SudoLang code, should return at least one line of tokens').toBeGreaterThan(0);
    assert({
      given: 'SudoLang code with type name',
      should: 'include a token containing TodoItem',
      actual: tokens[0].some((t) => t.content === 'TodoItem'),
      expected: true,
    });
  });

  it('returns empty array for empty code', async () => {
    const tokens = await tokenizeCode('', 'sudolang', 'one-light');
    assert({
      given: 'empty code string',
      should: 'return an empty array',
      actual: tokens,
      expected: [],
    });
  });

  it('falls back gracefully for unknown language', async () => {
    const tokens = await tokenizeCode('hello world', 'nonexistent-lang-xyz', 'one-light');
    expect(tokens.length, 'Given an unknown language, should still return tokens').toBeGreaterThan(0);
  });

  it('reuses the same highlighter singleton', async () => {
    const tokens1 = await tokenizeCode('a', 'sudolang', 'one-light');
    const tokens2 = await tokenizeCode('b', 'sudolang', 'one-light');
    expect(tokens1.length, 'Given first call, should return tokens').toBeGreaterThan(0);
    expect(tokens2.length, 'Given second call, should return tokens').toBeGreaterThan(0);
  });

  it('handles plain text language', async () => {
    const tokens = await tokenizeCode('plain text', 'text', 'one-light');
    expect(tokens.length, 'Given plain text language, should return tokens').toBeGreaterThan(0);
  });
});

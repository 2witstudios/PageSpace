import { describe, it, expect } from 'vitest';
import { tokenizeCode } from '../shiki-highlighter';

describe('Shiki Highlighter Service', () => {
  it('tokenizes JavaScript code', async () => {
    const tokens = await tokenizeCode('const x = 1', 'javascript', 'one-light');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].length).toBeGreaterThan(0);
    expect(tokens[0].some((t) => t.color !== undefined)).toBe(true);
  });

  it('tokenizes SudoLang code', async () => {
    const tokens = await tokenizeCode('TodoItem { id }', 'sudolang', 'one-light');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].some((t) => t.content === 'TodoItem')).toBe(true);
  });

  it('returns empty array for empty code', async () => {
    const tokens = await tokenizeCode('', 'sudolang', 'one-light');
    expect(tokens).toEqual([]);
  });

  it('falls back gracefully for unknown language', async () => {
    const tokens = await tokenizeCode('hello world', 'nonexistent-lang-xyz', 'one-light');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('reuses the same highlighter singleton', async () => {
    const tokens1 = await tokenizeCode('a', 'sudolang', 'one-light');
    const tokens2 = await tokenizeCode('b', 'sudolang', 'one-light');
    expect(tokens1.length).toBeGreaterThan(0);
    expect(tokens2.length).toBeGreaterThan(0);
  });

  it('handles plain text language', async () => {
    const tokens = await tokenizeCode('plain text', 'text', 'one-light');
    expect(tokens.length).toBeGreaterThan(0);
  });
});

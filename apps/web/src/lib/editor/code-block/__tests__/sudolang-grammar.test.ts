import { describe, it, expect, beforeAll } from 'vitest';
import { createHighlighter, type Highlighter } from 'shiki';
import { sudolangGrammar } from '../sudolang-grammar';

let highlighter: Highlighter;

/**
 * Extract all unique scope names from a tokenized line.
 * Shiki merges tokens with the same color, so we look through ALL
 * explanation entries (not just the first) to find scopes that were
 * assigned even if they share a color with adjacent text.
 */
function getAllScopes(code: string): string[] {
  const result = highlighter.codeToTokens(code, {
    lang: 'sudolang',
    theme: 'one-light',
    includeExplanation: true,
  });
  return result.tokens.flatMap((line) =>
    line.flatMap((token) =>
      (token.explanation ?? []).map(
        (exp) => exp.scopes.at(-1)?.scopeName ?? ''
      )
    )
  );
}

beforeAll(async () => {
  highlighter = await createHighlighter({
    themes: ['one-light'],
    langs: [sudolangGrammar],
  });
});

describe('SudoLang TextMate Grammar', () => {
  it('tokenizes line comments', () => {
    const scopes = getAllScopes('// comment');
    expect(scopes).toContain('comment.line.double-slash.sudolang');
  });

  it('tokenizes block comments', () => {
    const scopes = getAllScopes('/* block */');
    expect(scopes.some((s) => s.includes('comment.block.sudolang'))).toBe(true);
  });

  it('tokenizes double-quoted strings', () => {
    const scopes = getAllScopes('"hello"');
    expect(scopes.some((s) => s.includes('string.quoted.double.sudolang'))).toBe(true);
  });

  it('tokenizes single-quoted strings', () => {
    const scopes = getAllScopes("'hello'");
    expect(scopes.some((s) => s.includes('string.quoted.single.sudolang'))).toBe(true);
  });

  it('tokenizes type definitions', () => {
    const scopes = getAllScopes('TodoItem {');
    expect(scopes).toContain('entity.name.type.sudolang');
  });

  it('tokenizes function definitions', () => {
    const scopes = getAllScopes('createTodo(');
    expect(scopes).toContain('entity.name.function.sudolang');
  });

  it('tokenizes constraint keywords', () => {
    const scopes = getAllScopes('Constraints');
    expect(scopes).toContain('keyword.control.sudolang');
  });

  it('tokenizes pipe operator', () => {
    const scopes = getAllScopes('x |> y');
    expect(scopes).toContain('keyword.operator.pipe.sudolang');
  });

  it('tokenizes arrow operator', () => {
    const scopes = getAllScopes('x => y');
    expect(scopes).toContain('keyword.operator.arrow.sudolang');
  });

  it('tokenizes slash commands', () => {
    const scopes = getAllScopes('/help');
    expect(scopes).toContain('entity.name.tag.sudolang');
  });

  it('tokenizes headings', () => {
    const scopes = getAllScopes('# Heading');
    expect(scopes).toContain('markup.heading.sudolang');
  });

  it('tokenizes numbers', () => {
    const scopes = getAllScopes('42');
    expect(scopes).toContain('constant.numeric.sudolang');
  });

  it('tokenizes language constants', () => {
    const scopes = getAllScopes('true');
    expect(scopes).toContain('constant.language.sudolang');
  });

  it('handles a full SudoLang snippet', () => {
    const snippet = `// Todo App
TodoItem {
  id,
  text,
  isComplete,
}

createTodo({ text = '' }) => ActionObject

Constraints {
  text |> validate
}`;
    const allScopes = getAllScopes(snippet);

    expect(allScopes).toContain('comment.line.double-slash.sudolang');
    expect(allScopes).toContain('entity.name.type.sudolang');
    expect(allScopes).toContain('entity.name.function.sudolang');
    expect(allScopes).toContain('keyword.control.sudolang');
    expect(allScopes).toContain('keyword.operator.pipe.sudolang');
    expect(allScopes).toContain('keyword.operator.arrow.sudolang');
  });
});

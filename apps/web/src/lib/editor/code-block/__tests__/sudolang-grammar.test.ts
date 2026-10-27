import { describe, it, expect, beforeAll } from 'vitest';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { assert } from '@/test/riteway';
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
    lang: 'sudolang' as BundledLanguage,
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
    expect(scopes, 'Given a line comment, should contain comment scope').toContain('comment.line.double-slash.sudolang');
  });

  it('tokenizes block comments', () => {
    const scopes = getAllScopes('/* block */');
    assert({
      given: 'a block comment',
      should: 'include block comment scope',
      actual: scopes.some((s) => s.includes('comment.block.sudolang')),
      expected: true,
    });
  });

  it('tokenizes double-quoted strings', () => {
    const scopes = getAllScopes('"hello"');
    assert({
      given: 'a double-quoted string',
      should: 'include double-quoted string scope',
      actual: scopes.some((s) => s.includes('string.quoted.double.sudolang')),
      expected: true,
    });
  });

  it('tokenizes single-quoted strings', () => {
    const scopes = getAllScopes("'hello'");
    assert({
      given: 'a single-quoted string',
      should: 'include single-quoted string scope',
      actual: scopes.some((s) => s.includes('string.quoted.single.sudolang')),
      expected: true,
    });
  });

  it('tokenizes type definitions', () => {
    const scopes = getAllScopes('TodoItem {');
    expect(scopes, 'Given a type definition, should contain type scope').toContain('entity.name.type.sudolang');
  });

  it('tokenizes function definitions', () => {
    const scopes = getAllScopes('createTodo(');
    expect(scopes, 'Given a function definition, should contain function scope').toContain('entity.name.function.sudolang');
  });

  it('tokenizes constraint keywords', () => {
    const scopes = getAllScopes('Constraints');
    expect(scopes, 'Given Constraints keyword, should contain keyword scope').toContain('keyword.control.sudolang');
  });

  it('tokenizes pipe operator', () => {
    const scopes = getAllScopes('x |> y');
    expect(scopes, 'Given pipe operator, should contain pipe scope').toContain('keyword.operator.pipe.sudolang');
  });

  it('tokenizes arrow operator', () => {
    const scopes = getAllScopes('x => y');
    expect(scopes, 'Given arrow operator, should contain arrow scope').toContain('keyword.operator.arrow.sudolang');
  });

  it('tokenizes slash commands', () => {
    const scopes = getAllScopes('/help');
    expect(scopes, 'Given slash command, should contain tag scope').toContain('entity.name.tag.sudolang');
  });

  it('tokenizes headings', () => {
    const scopes = getAllScopes('# Heading');
    expect(scopes, 'Given heading, should contain heading scope').toContain('markup.heading.sudolang');
  });

  it('tokenizes numbers', () => {
    const scopes = getAllScopes('42');
    expect(scopes, 'Given a number, should contain numeric scope').toContain('constant.numeric.sudolang');
  });

  it('tokenizes language constants', () => {
    const scopes = getAllScopes('true');
    expect(scopes, 'Given true, should contain language constant scope').toContain('constant.language.sudolang');
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

    expect(allScopes, 'Given full snippet, should contain comment scope').toContain('comment.line.double-slash.sudolang');
    expect(allScopes, 'Given full snippet, should contain type scope').toContain('entity.name.type.sudolang');
    expect(allScopes, 'Given full snippet, should contain function scope').toContain('entity.name.function.sudolang');
    expect(allScopes, 'Given full snippet, should contain keyword scope').toContain('keyword.control.sudolang');
    expect(allScopes, 'Given full snippet, should contain pipe scope').toContain('keyword.operator.pipe.sudolang');
    expect(allScopes, 'Given full snippet, should contain arrow scope').toContain('keyword.operator.arrow.sudolang');
  });
});

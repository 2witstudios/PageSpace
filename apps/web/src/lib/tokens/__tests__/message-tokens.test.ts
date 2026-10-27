import { describe, it, expect } from 'vitest';
import {
  parseMessageTokens,
  serializeMessageTokens,
  updateTokenPositions,
  validTokensForText,
  tokenSigil,
  tokenDisplayText,
  TrackedToken,
} from '../message-tokens';

describe('tokenSigil / tokenDisplayText', () => {
  it('given a mention type, should use the @ sigil', () => {
    expect(tokenSigil('user')).toBe('@');
    expect(tokenSigil('page')).toBe('@');
    expect(tokenSigil('everyone')).toBe('@');
    expect(tokenSigil('role')).toBe('@');
  });

  it('given the command type, should use the / sigil', () => {
    expect(tokenSigil('command')).toBe('/');
  });

  it('given a token, should produce sigil-prefixed display text', () => {
    expect(tokenDisplayText('Alice', 'user')).toBe('@Alice');
    expect(tokenDisplayText('release-checklist', 'command')).toBe('/release-checklist');
  });
});

describe('parseMessageTokens — mention parity', () => {
  it('given plain text with no tokens, should return text unchanged', () => {
    const result = parseMessageTokens('hello world');
    expect(result.displayText).toBe('hello world');
    expect(result.tokens).toEqual([]);
  });

  it('given empty string, should return empty string', () => {
    const result = parseMessageTokens('');
    expect(result.displayText).toBe('');
    expect(result.tokens).toEqual([]);
  });

  it('given a single page mention, should extract display text and position', () => {
    const result = parseMessageTokens('@[My Page](abc123:page)');
    expect(result.displayText).toBe('@My Page');
    expect(result.tokens).toEqual([
      { start: 0, end: 8, label: 'My Page', id: 'abc123', type: 'page' },
    ]);
  });

  it('given mention surrounded by text, should calculate correct positions', () => {
    const result = parseMessageTokens('Hello @[Alice](user1:user) world');
    expect(result.displayText).toBe('Hello @Alice world');
    expect(result.tokens).toEqual([
      { start: 6, end: 12, label: 'Alice', id: 'user1', type: 'user' },
    ]);
  });

  it('given multiple mentions, should track all positions correctly', () => {
    const result = parseMessageTokens('Hey @[Alice](a:user) and @[Doc](d:page) bye');
    expect(result.displayText).toBe('Hey @Alice and @Doc bye');
    expect(result.tokens).toEqual([
      { start: 4, end: 10, label: 'Alice', id: 'a', type: 'user' },
      { start: 15, end: 19, label: 'Doc', id: 'd', type: 'page' },
    ]);
  });

  it('given adjacent mentions, should calculate positions correctly', () => {
    const result = parseMessageTokens('@[Alice](a:user)@[Bob](b:user)');
    expect(result.displayText).toBe('@Alice@Bob');
    expect(result.tokens).toEqual([
      { start: 0, end: 6, label: 'Alice', id: 'a', type: 'user' },
      { start: 6, end: 10, label: 'Bob', id: 'b', type: 'user' },
    ]);
  });
});

describe('parseMessageTokens — command tokens', () => {
  it('given a command token, should display /trigger and track it as a command', () => {
    const result = parseMessageTokens('/[release-checklist](cmd123:command)');
    expect(result.displayText).toBe('/release-checklist');
    expect(result.tokens).toEqual([
      { start: 0, end: 18, label: 'release-checklist', id: 'cmd123', type: 'command' },
    ]);
  });

  it('given a command token followed by text, should track positions', () => {
    const result = parseMessageTokens('/[foo](c1:command) please do the thing');
    expect(result.displayText).toBe('/foo please do the thing');
    expect(result.tokens).toEqual([
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
    ]);
  });

  it('given a command token and a mention in one message, should track both', () => {
    const result = parseMessageTokens('/[foo](c1:command) hi @[Alice](u1:user)');
    expect(result.displayText).toBe('/foo hi @Alice');
    expect(result.tokens).toEqual([
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
      { start: 8, end: 14, label: 'Alice', id: 'u1', type: 'user' },
    ]);
  });

  it('given a mention before a command token, should track both in order', () => {
    const result = parseMessageTokens('@[Alice](u1:user) /[foo](c1:command)');
    expect(result.displayText).toBe('@Alice /foo');
    expect(result.tokens).toEqual([
      { start: 0, end: 6, label: 'Alice', id: 'u1', type: 'user' },
      { start: 7, end: 11, label: 'foo', id: 'c1', type: 'command' },
    ]);
  });

  it('given a slash-sigil token whose type is not command, should keep it as literal text', () => {
    const raw = '/[foo](c1:user) hello';
    const result = parseMessageTokens(raw);
    expect(result.displayText).toBe(raw);
    expect(result.tokens).toEqual([]);
  });

  it('given an @-sigil token whose type is command, should keep it as literal text (sigil and type must agree)', () => {
    const raw = '@[foo](c1:command) hello';
    const result = parseMessageTokens(raw);
    expect(result.displayText).toBe(raw);
    expect(result.tokens).toEqual([]);
  });

  it('given a plain literal /foo text, should not produce a token', () => {
    const result = parseMessageTokens('/foo bar');
    expect(result.displayText).toBe('/foo bar');
    expect(result.tokens).toEqual([]);
  });

  it('given a built-in command id containing a colon, should split id/type on the LAST colon', () => {
    const result = parseMessageTokens('/[help](builtin:help:command) what can I do');
    expect(result.displayText).toBe('/help what can I do');
    expect(result.tokens).toEqual([
      { start: 0, end: 5, label: 'help', id: 'builtin:help', type: 'command' },
    ]);
  });

  it('round-trips a built-in command chip', () => {
    const raw = '/[help](builtin:help:command) hi';
    const { displayText, tokens } = parseMessageTokens(raw);
    expect(serializeMessageTokens(displayText, tokens)).toBe(raw);
  });
});

describe('serializeMessageTokens', () => {
  it('given no tokens, should return display text unchanged', () => {
    expect(serializeMessageTokens('hello', [])).toBe('hello');
  });

  it('given a mention token, should serialize to @[label](id:type)', () => {
    const tokens: TrackedToken[] = [
      { start: 6, end: 12, label: 'Alice', id: 'u1', type: 'user' },
    ];
    expect(serializeMessageTokens('Hello @Alice world', tokens)).toBe(
      'Hello @[Alice](u1:user) world'
    );
  });

  it('given a command token, should serialize to /[label](id:command)', () => {
    const tokens: TrackedToken[] = [
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
    ];
    expect(serializeMessageTokens('/foo do the thing', tokens)).toBe(
      '/[foo](c1:command) do the thing'
    );
  });

  it('given mixed tokens out of order, should serialize sorted by position', () => {
    const tokens: TrackedToken[] = [
      { start: 8, end: 14, label: 'Alice', id: 'u1', type: 'user' },
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
    ];
    expect(serializeMessageTokens('/foo hi @Alice', tokens)).toBe(
      '/[foo](c1:command) hi @[Alice](u1:user)'
    );
  });

  it('round-trips parse -> serialize for mixed content', () => {
    const markdown = '/[foo](c1:command) hi @[Alice](u1:user) end';
    const { displayText, tokens } = parseMessageTokens(markdown);
    expect(serializeMessageTokens(displayText, tokens)).toBe(markdown);
  });

  it('stays stable across multiple round-trips', () => {
    let markdown = 'Hey @[Alice](a:user), see @[Doc](d:page) and /[ship](c1:command)';
    for (let i = 0; i < 3; i++) {
      const { displayText, tokens } = parseMessageTokens(markdown);
      markdown = serializeMessageTokens(displayText, tokens);
    }
    expect(markdown).toBe('Hey @[Alice](a:user), see @[Doc](d:page) and /[ship](c1:command)');
  });
});

describe('updateTokenPositions', () => {
  const commandToken: TrackedToken = {
    start: 0,
    end: 4,
    label: 'foo',
    id: 'c1',
    type: 'command',
  };

  it('given text appended after the token, should keep positions', () => {
    const updated = updateTokenPositions([commandToken], '/foo ', '/foo hello');
    expect(updated).toEqual([commandToken]);
  });

  it('given text inserted before the token, should shift it right', () => {
    const updated = updateTokenPositions([commandToken], '/foo ', 'hey /foo ');
    expect(updated).toEqual([{ ...commandToken, start: 4, end: 8 }]);
  });

  it('given an edit overlapping the token, should drop the token (chip dissolves)', () => {
    // Backspace deleting the final char of '/foo'
    const updated = updateTokenPositions([commandToken], '/foo ', '/fo ');
    expect(updated).toEqual([]);
  });

  it('given an edit strictly inside the token, should drop the token', () => {
    const updated = updateTokenPositions([commandToken], '/foo ', '/fXoo ');
    expect(updated).toEqual([]);
  });

  it('given a deletion before the token, should shift it left', () => {
    const token: TrackedToken = { start: 4, end: 8, label: 'foo', id: 'c1', type: 'command' };
    const updated = updateTokenPositions([token], 'hey /foo ', 'he /foo ');
    expect(updated).toEqual([{ ...token, start: 3, end: 7 }]);
  });
});

describe('validTokensForText', () => {
  it('keeps tokens whose display text matches exactly', () => {
    const tokens: TrackedToken[] = [
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
      { start: 5, end: 11, label: 'Alice', id: 'u1', type: 'user' },
    ];
    expect(validTokensForText(tokens, '/foo @Alice')).toEqual(tokens);
  });

  it('drops tokens whose text no longer matches (manual retype is not a chip)', () => {
    const tokens: TrackedToken[] = [
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
    ];
    expect(validTokensForText(tokens, '/fop rest')).toEqual([]);
  });

  it('drops a command token whose sigil was replaced by @', () => {
    const tokens: TrackedToken[] = [
      { start: 0, end: 4, label: 'foo', id: 'c1', type: 'command' },
    ];
    expect(validTokensForText(tokens, '@foo rest')).toEqual([]);
  });
});

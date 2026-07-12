import { describe, it, expect } from 'vitest';
import { slugifySegment, hasNameContent, destroysNameContent, slugDigest } from '../name-slug';

describe('slugifySegment', () => {
  it.each([
    ['My Cool Feature', 'my-cool-feature'],
    ['JIRA-123 Fix!!', 'jira-123-fix'],
    ['a_b', 'a-b'],
    ['v1.2', 'v1.2'],
    ['a..b', 'a-b'],
    ['  padded  ', 'padded'],
    ['--edges--', 'edges'],
    ['émoji', 'emoji'],
    ['🚀', ''],
    ['..', ''],
    ['', ''],
  ])('given %j, should slugify to %j', (input, expected) => {
    expect(slugifySegment(input)).toBe(expected);
  });

  it('should be idempotent — the output holds no runs, no edge separators, no out-of-charset characters', () => {
    for (const input of ['My Cool Feature', 'a..b', '--x--', 'émoji 🚀', 'A_B C']) {
      const once = slugifySegment(input);
      expect(slugifySegment(once)).toBe(once);
    }
  });
});

describe('hasNameContent', () => {
  it.each(['', '   ', '\t\n', '.', '..', '...', '/', '//', '../', '-', '---', '. . .'])(
    'given the nameless %j, should report no content',
    (input) => {
      expect(hasNameContent(input)).toBe(false);
    },
  );

  it.each(['a', 'my-repo', '日本語', '🚀', '!!!', '___', 'a.b', '-x', 'feature/foo'])(
    'given %j, which carries a name, should report content',
    (input) => {
      expect(hasNameContent(input)).toBe(true);
    },
  );

  it('is the predicate the API guards on, so it must cover EVERY input that reaches a fallback', () => {
    // The route guards reject `!hasNameContent(name)` precisely because every such
    // input normalizes to `branch`/`project` — which would otherwise address a REAL
    // resource of that name. `!!!` and `___` are NOT nameless: they get a digest
    // token instead, so they must pass the guard.
    expect(hasNameContent('..')).toBe(false);
    expect(hasNameContent('!!!')).toBe(true);
  });
});

describe('destroysNameContent', () => {
  it.each(['My Cool Feature', 'a!b', 'a b', 'JIRA-123', 'émoji', 'v1.2', 'a_b', 'ＡＢ'])(
    'given %j, whose meaning survives ASCII, should report no loss',
    (input) => {
      expect(destroysNameContent(input)).toBe(false);
    },
  );

  it.each(['日本語', '🚀', 'Ωλ', 'my 🚀 feature', '한국어 wip'])(
    'given %j, which holds characters ASCII cannot express, should report loss',
    (input) => {
      expect(destroysNameContent(input)).toBe(true);
    },
  );

  it('should treat ASCII punctuation as structure, not identity', () => {
    // This is the design's one accepted loss: `a b` and `a!b` are one name.
    expect(destroysNameContent('a!?#$%b')).toBe(false);
  });
});

describe('slugDigest', () => {
  it('should be deterministic and charset-safe', () => {
    expect(slugDigest('日本語')).toBe(slugDigest('日本語'));
    expect(slugDigest('日本語')).toMatch(/^[a-z0-9]+$/);
  });

  it('should separate names that differ, and only those', () => {
    expect(slugDigest('日本語')).not.toBe(slugDigest('한국어'));
    // Hashes the name's IDENTITY, not its raw text — so case, ASCII punctuation and
    // whitespace do NOT split one name in two, even when it holds an emoji. Hashing
    // raw text was a real bug: `MY 🚀 FEATURE` and `my 🚀 feature` minted two
    // branches, two Sprites, two clones.
    expect(slugDigest('MY 🚀 FEATURE')).toBe(slugDigest('my 🚀 feature'));
    expect(slugDigest('my!🚀!feature')).toBe(slugDigest('my 🚀 feature'));
    expect(slugDigest('  my  🚀  feature  ')).toBe(slugDigest('my 🚀 feature'));
    expect(slugDigest('my 🎉 feature')).not.toBe(slugDigest('my 🚀 feature'));
  });
});

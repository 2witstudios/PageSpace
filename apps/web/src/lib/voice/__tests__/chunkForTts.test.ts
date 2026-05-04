import { describe, it, expect } from 'vitest';
import {
  normalizeForSpeech,
  chunkStreamingForTts,
  flushForTts,
  splitOversizedForTts,
} from '../chunkForTts';

describe('normalizeForSpeech', () => {
  it('strips fenced code blocks', () => {
    const input = 'Hello.\n```js\nconst x = 1;\n```\nWorld.';
    const out = normalizeForSpeech(input);
    expect(out).not.toContain('```');
    expect(out).not.toContain('const x');
    expect(out).toContain('Hello');
    expect(out).toContain('World');
  });

  it('unwraps inline code', () => {
    expect(normalizeForSpeech('Use `foo` here.')).toBe('Use foo here.');
  });

  it('removes heading hashes', () => {
    expect(normalizeForSpeech('# Title\n\nBody.')).toBe('Title. Body.');
  });

  it('removes bullet list markers', () => {
    const out = normalizeForSpeech('- First.\n- Second.\n- Third.');
    expect(out).not.toMatch(/^-/);
    expect(out).toContain('First');
    expect(out).toContain('Second');
    expect(out).toContain('Third');
  });

  it('removes ordered list markers', () => {
    const out = normalizeForSpeech('1. One.\n2. Two.\n3. Three.');
    expect(out).not.toMatch(/^\d+\./);
    expect(out).toContain('One');
    expect(out).toContain('Two');
  });

  it('strips bold and italic markers', () => {
    expect(normalizeForSpeech('This is **bold** and _italic_ text.')).toBe(
      'This is bold and italic text.'
    );
  });

  it('keeps link text and drops the URL', () => {
    expect(normalizeForSpeech('See [the docs](https://example.com) now.')).toBe(
      'See the docs now.'
    );
  });

  it('drops images entirely', () => {
    const out = normalizeForSpeech('Look ![alt](https://img.png) here.');
    expect(out).not.toContain('img.png');
    expect(out).not.toContain('alt');
  });

  it('treats paragraph breaks as sentence boundaries', () => {
    expect(normalizeForSpeech('First paragraph\n\nSecond paragraph')).toBe(
      'First paragraph. Second paragraph'
    );
  });

  it('does not split single newlines inside a paragraph', () => {
    expect(normalizeForSpeech('Line one\nstill same sentence.')).toBe(
      'Line one still same sentence.'
    );
  });

  it('collapses repeated whitespace', () => {
    expect(normalizeForSpeech('a   b\t\tc')).toBe('a b c');
  });

  it('removes blockquote markers', () => {
    expect(normalizeForSpeech('> quoted text')).toBe('quoted text');
  });

  it('removes horizontal rules', () => {
    const out = normalizeForSpeech('Above.\n\n---\n\nBelow.');
    expect(out).toContain('Above');
    expect(out).toContain('Below');
    expect(out).not.toContain('---');
  });
});

describe('chunkStreamingForTts', () => {
  it('returns the buffer as pending when no terminator is present', () => {
    const result = chunkStreamingForTts('Hello world without a period');
    expect(result.ready).toEqual([]);
    expect(result.pending).toBe('Hello world without a period');
  });

  it('emits a complete sentence and clears pending', () => {
    const result = chunkStreamingForTts('Hello world. ');
    expect(result.ready).toEqual(['Hello world.']);
    expect(result.pending).toBe('');
  });

  it('keeps the unfinished tail in pending across chunks', () => {
    const result = chunkStreamingForTts('First sentence. Partial seco');
    expect(result.ready).toEqual(['First sentence.']);
    expect(result.pending).toBe('Partial seco');
  });

  it('treats a paragraph break as a hard boundary', () => {
    const result = chunkStreamingForTts('No period here\n\nNext bit');
    expect(result.ready.length).toBeGreaterThan(0);
    expect(result.ready.join(' ')).toContain('No period here');
    expect(result.pending).toBe('Next bit');
  });

  it('does not split on a single newline inside a paragraph', () => {
    const result = chunkStreamingForTts('Line one\nLine two\nLine three.');
    expect(result.ready).toEqual(['Line one Line two Line three.']);
  });

  it('packs multiple short sentences into a single chunk', () => {
    const input = 'One. Two. Three. Four. Five. ';
    const result = chunkStreamingForTts(input, { maxChars: 1500 });
    expect(result.ready.length).toBe(1);
    expect(result.ready[0]).toContain('One');
    expect(result.ready[0]).toContain('Five');
  });

  it('respects maxChars when packing', () => {
    const sentence = 'This is a sample sentence. ';
    const input = sentence.repeat(50);
    const result = chunkStreamingForTts(input, { maxChars: 100 });
    for (const chunk of result.ready) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('strips markdown noise before shipping', () => {
    const result = chunkStreamingForTts('# Title\n\n- bullet item.\n\n');
    expect(result.ready.join(' ')).not.toContain('#');
    expect(result.ready.join(' ')).not.toMatch(/^-/);
  });

  it('returns empty result for empty input', () => {
    expect(chunkStreamingForTts('')).toEqual({ ready: [], pending: '' });
  });

  it('returns empty ready when buffer normalizes to nothing', () => {
    const result = chunkStreamingForTts('```\njust code\n```\n\n');
    expect(result.ready).toEqual([]);
  });
});

describe('flushForTts', () => {
  it('ships text without a terminator on final flush', () => {
    const out = flushForTts('Tail text without period');
    expect(out).toEqual(['Tail text without period']);
  });

  it('returns empty for empty input', () => {
    expect(flushForTts('')).toEqual([]);
  });

  it('splits oversized tail across multiple chunks', () => {
    const long = 'word '.repeat(500).trim();
    const out = flushForTts(long, { maxChars: 200 });
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it('strips markdown on flush', () => {
    const out = flushForTts('# Heading\n\n- item without period');
    expect(out.join(' ')).not.toContain('#');
    expect(out.join(' ')).toContain('Heading');
    expect(out.join(' ')).toContain('item without period');
  });
});

describe('splitOversizedForTts', () => {
  it('returns the input unchanged when under the limit', () => {
    expect(splitOversizedForTts('short text', 100)).toEqual(['short text']);
  });

  it('splits a long string on word boundaries', () => {
    const text = 'word '.repeat(100).trim();
    const out = splitOversizedForTts(text, 50);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(chunk).not.toMatch(/^ /);
      expect(chunk).not.toMatch(/ $/);
    }
  });

  it('never produces empty chunks', () => {
    const out = splitOversizedForTts('a '.repeat(200).trim(), 10);
    for (const chunk of out) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('hard-cuts when no whitespace exists', () => {
    const noSpace = 'a'.repeat(120);
    const out = splitOversizedForTts(noSpace, 50);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it('preserves all content (no characters dropped)', () => {
    const input = 'one two three four five six seven eight nine ten';
    const out = splitOversizedForTts(input, 15);
    const recombined = out.join(' ');
    for (const word of input.split(' ')) {
      expect(recombined).toContain(word);
    }
  });
});

describe('streaming end-to-end simulation', () => {
  it('handles a markdown response with a code block without dropping content', () => {
    let buffer = '';
    const tokens = [
      'Here is some code:\n\n',
      '```js\n',
      'const x = 1;\n',
      'console.log(x);\n',
      '```\n\n',
      'Done.',
    ];
    const allReady: string[] = [];
    for (const t of tokens) {
      buffer += t;
      const r = chunkStreamingForTts(buffer);
      allReady.push(...r.ready);
      buffer = r.pending;
    }
    allReady.push(...flushForTts(buffer));
    const combined = allReady.join(' ');
    expect(combined).toContain('Here is some code');
    expect(combined).toContain('Done');
    expect(combined).not.toContain('```');
    expect(combined).not.toContain('const x');
  });

  it('handles a long unpunctuated paragraph by flushing it at end', () => {
    const long = 'word '.repeat(800).trim();
    let buffer = '';
    const allReady: string[] = [];
    for (const t of long.match(/.{1,40}/g) ?? []) {
      buffer += t;
      const r = chunkStreamingForTts(buffer);
      allReady.push(...r.ready);
      buffer = r.pending;
    }
    allReady.push(...flushForTts(buffer));
    expect(allReady.length).toBeGreaterThan(0);
    const combined = allReady.join(' ');
    expect(combined.replace(/\s+/g, ' ').trim()).toContain('word word');
    expect(combined.split(/\s+/).filter(Boolean).length).toBe(800);
  });
});

import { describe, it } from 'vitest';
import type { ThemedToken } from 'shiki';
import { assert } from './riteway';
import { tokensToDecorationSpecs } from '../token-decorations';

function makeToken(content: string, color?: string, fontStyle?: number): ThemedToken {
  return { content, color, fontStyle, offset: 0 } as ThemedToken;
}

describe('tokensToDecorationSpecs', () => {
  it('maps a single token to a decoration spec', () => {
    const tokens: ThemedToken[][] = [[makeToken('const', '#A626A4')]];
    const specs = tokensToDecorationSpecs(tokens, 10);
    assert({
      given: 'a single token at offset 10',
      should: 'map to correct from/to/style',
      actual: specs,
      expected: [{ from: 10, to: 15, style: 'color: #A626A4' }],
    });
  });

  it('maps multiple tokens on one line with sequential offsets', () => {
    const tokens: ThemedToken[][] = [
      [makeToken('const', '#A626A4'), makeToken(' ', '#383A42'), makeToken('x', '#E45649')],
    ];
    const specs = tokensToDecorationSpecs(tokens, 0);
    assert({
      given: 'multiple tokens on one line',
      should: 'produce sequential decorations skipping whitespace',
      actual: specs,
      expected: [
        { from: 0, to: 5, style: 'color: #A626A4' },
        { from: 6, to: 7, style: 'color: #E45649' },
      ],
    });
  });

  it('handles multi-line tokens with newline offset', () => {
    const tokens: ThemedToken[][] = [
      [makeToken('line1', '#A626A4')],
      [makeToken('line2', '#E45649')],
    ];
    const specs = tokensToDecorationSpecs(tokens, 0);
    assert({
      given: 'tokens across two lines',
      should: 'account for newline offset between lines',
      actual: specs,
      expected: [
        { from: 0, to: 5, style: 'color: #A626A4' },
        { from: 6, to: 11, style: 'color: #E45649' },
      ],
    });
  });

  it('skips whitespace-only tokens', () => {
    const tokens: ThemedToken[][] = [
      [makeToken('  ', '#383A42'), makeToken('text', '#A626A4')],
    ];
    const specs = tokensToDecorationSpecs(tokens, 0);
    assert({
      given: 'a whitespace-only token followed by text',
      should: 'skip the whitespace token',
      actual: specs,
      expected: [{ from: 2, to: 6, style: 'color: #A626A4' }],
    });
  });

  it('includes fontStyle CSS for bold/italic', () => {
    const tokens: ThemedToken[][] = [[makeToken('comment', '#A0A1A7', 1)]];
    const specs = tokensToDecorationSpecs(tokens, 0);
    assert({
      given: 'a token with italic fontStyle (1)',
      should: 'include font-style: italic in CSS',
      actual: specs[0].style,
      expected: 'color: #A0A1A7; font-style: italic',
    });
  });

  it('includes fontStyle CSS for bold', () => {
    const tokens: ThemedToken[][] = [[makeToken('bold', '#A0A1A7', 2)]];
    const specs = tokensToDecorationSpecs(tokens, 0);
    assert({
      given: 'a token with bold fontStyle (2)',
      should: 'include font-weight: bold in CSS',
      actual: specs[0].style,
      expected: 'color: #A0A1A7; font-weight: bold',
    });
  });

  it('returns empty array for empty input', () => {
    assert({
      given: 'empty token array',
      should: 'return empty decoration specs',
      actual: tokensToDecorationSpecs([], 0),
      expected: [],
    });
  });
});

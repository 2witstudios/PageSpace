import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { matchParts } from './palette-match';

describe('matchParts()', () => {
  test('one word', () => {
    assert({
      given: 'a title and a query in a different case',
      should: 'tint the matching run and keep the title’s own case',
      actual: matchParts('Roadmap — Q4', 'ROAD'),
      expected: [
        { text: 'Road', match: true },
        { text: 'map — Q4', match: false },
      ],
    });
  });

  test('several words, more than once', () => {
    assert({
      given: 'a query whose words appear apart, one of them twice, and one word inside another',
      should: 'tint every run, the longer word winning',
      actual: matchParts('Road crew road roadmap', 'road  roadmap crew'),
      expected: [
        { text: 'Road', match: true },
        { text: ' ', match: false },
        { text: 'crew', match: true },
        { text: ' ', match: false },
        { text: 'road', match: true },
        { text: ' ', match: false },
        { text: 'roadmap', match: true },
      ],
    });
  });

  test('nothing to tint', () => {
    assert({
      given: 'a blank query, a query that matches nothing, and a query of pattern characters',
      should: 'give the title back whole, and treat pattern characters as text',
      actual: [matchParts('Roadmap', '  '), matchParts('Roadmap', 'zebra'), matchParts('Q4 (draft)', '(d')],
      expected: [
        [{ text: 'Roadmap', match: false }],
        [{ text: 'Roadmap', match: false }],
        [
          { text: 'Q4 ', match: false },
          { text: '(d', match: true },
          { text: 'raft)', match: false },
        ],
      ],
    });
  });
});

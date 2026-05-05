import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { extractMentionedUserIds } from '../extract-user-mentions';

describe('extractMentionedUserIds', () => {
  it('returns user IDs from `:user` mentions and skips `:page` mentions', () => {
    assert({
      given: 'a body with two `:user` mentions and one `:page` mention',
      should: 'extract only the user IDs in first-seen order',
      actual: extractMentionedUserIds(
        'hi @[Alice](u-alice:user) and @[Doc](p-doc:page) and @[Bob](u-bob:user)'
      ),
      expected: ['u-alice', 'u-bob'],
    });
  });

  it('dedupes the same user mentioned twice', () => {
    assert({
      given: 'a body that mentions the same user twice',
      should: 'collapse duplicates into one ID',
      actual: extractMentionedUserIds('@[Alice](u1:user) hello @[Alice](u1:user)'),
      expected: ['u1'],
    });
  });

  it('returns an empty array when content has no mentions', () => {
    assert({
      given: 'plain content with no mentions',
      should: 'return an empty array',
      actual: extractMentionedUserIds('hello world'),
      expected: [],
    });
  });

  it('returns an empty array for empty content', () => {
    assert({
      given: 'empty input',
      should: 'return an empty array',
      actual: extractMentionedUserIds(''),
      expected: [],
    });
  });
});

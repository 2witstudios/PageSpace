import { describe, it, expect } from 'vitest';
import { shouldApplyServerContent } from '../sync';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('shouldApplyServerContent', () => {
  it('applies new server content when the local doc is clean', () => {
    assert({
      given: 'incoming content different from local and not dirty',
      should: 'apply the server content',
      actual: shouldApplyServerContent('new', 'old', false),
      expected: true,
    });
  });

  it('ignores server content while the local doc is dirty (local edits win)', () => {
    assert({
      given: 'incoming content different from local but the doc is dirty',
      should: 'ignore the server content',
      actual: shouldApplyServerContent('new', 'old', true),
      expected: false,
    });
  });

  it('ignores identical server content even when clean', () => {
    assert({
      given: 'incoming content identical to local content',
      should: 'not re-apply it',
      actual: shouldApplyServerContent('same', 'same', false),
      expected: false,
    });
  });
});

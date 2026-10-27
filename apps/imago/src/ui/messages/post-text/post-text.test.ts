import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mentionsViewer, postParts } from './post-text';

describe('postParts()', () => {
  test('plain text', () => {
    assert({
      given: 'a post with no mentions',
      should: 'be one text run',
      actual: postParts('shipping today', 'u1'),
      expected: [{ kind: 'text', text: 'shipping today' }],
    });
  });

  test('mentions in the stored format', () => {
    assert({
      given: 'user, page and everyone mentions as the composer stores them, @[label](id:type)',
      should: 'split them out as mentions with their label, id and type, the viewer’s and @everyone flagged',
      actual: postParts('hi @[Ada Lovelace](u1:user) and @[Grace](u2:user), see @[Roadmap](p9:page) @[everyone](everyone:everyone)', 'u1'),
      expected: [
        { kind: 'text', text: 'hi ' },
        { kind: 'mention', label: 'Ada Lovelace', id: 'u1', type: 'user', you: true },
        { kind: 'text', text: ' and ' },
        { kind: 'mention', label: 'Grace', id: 'u2', type: 'user', you: false },
        { kind: 'text', text: ', see ' },
        { kind: 'mention', label: 'Roadmap', id: 'p9', type: 'page', you: false },
        { kind: 'text', text: ' ' },
        { kind: 'mention', label: 'everyone', id: 'everyone', type: 'everyone', you: true },
      ],
    });
  });

  test('markup is text', () => {
    assert({
      given: 'a post holding HTML and a bare @handle',
      should: 'keep both as plain text: only the stored mention format is a mention',
      actual: postParts('<img src=x onerror=alert(1)> @ada', 'u1'),
      expected: [{ kind: 'text', text: '<img src=x onerror=alert(1)> @ada' }],
    });
  });

  test('a role mention', () => {
    assert({
      given: 'a role mention as expand-group-mentions stores it',
      should: 'be a mention in accent ink, not yet marked as the viewer’s (role membership is not resolved client-side)',
      actual: postParts('@[Admins](ADMIN:role) please', 'u1'),
      expected: [
        { kind: 'mention', label: 'Admins', id: 'ADMIN', type: 'role', you: false },
        { kind: 'text', text: ' please' },
      ],
    });
  });

  test('a page id equal to the viewer’s', () => {
    assert({
      given: 'a page mention whose id happens to be the viewer’s user id',
      should: 'not count as mentioning the viewer',
      actual: postParts('@[Notes](u1:page)', 'u1'),
      expected: [{ kind: 'mention', label: 'Notes', id: 'u1', type: 'page', you: false }],
    });
  });
});

describe('mentionsViewer()', () => {
  test('whether a post calls the viewer', () => {
    assert({
      given: 'a post mentioning the viewer, one mentioning someone else, and one with none',
      should: 'be true only for the first',
      actual: ['@[Ada](u1:user) look', '@[Grace](u2:user) look', 'look'].map((text) => mentionsViewer(text, 'u1')),
      expected: [true, false, false],
    });
  });
});

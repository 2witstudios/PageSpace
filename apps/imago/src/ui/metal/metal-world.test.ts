// @vitest-environment jsdom
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { paintWorld } from './metal-world';

describe('paintWorld()', () => {
  test('no 2D canvas', () => {
    assert({
      given: 'a document whose canvases have no 2D context (jsdom has none)',
      should: 'paint nothing and say so, so the engine keeps its last world',
      actual: paintWorld(document.createElement('canvas'), document),
      expected: false,
    });
  });
});

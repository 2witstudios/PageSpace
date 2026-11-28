// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { ImagoOrb } from './imago-orb';
import { imagoOrbClass } from './imago-orb-class';

afterEach(unmountAll);

describe('<ImagoOrb>', () => {
  test('without WebGL2', () => {
    const root = mount(<ImagoOrb size="glyph" live />);
    assert({
      given: 'a browser with no engine (jsdom has no WebGL2)',
      should: 'fall back to the still chrome ball',
      actual: root.querySelector('canvas')?.getAttribute('class'),
      expected: imagoOrbClass('glyph', true),
    });
  });
});

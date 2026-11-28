// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { ToolbarStrip, toolbarStripClass } from './toolbar-strip';

afterEach(unmountAll);

describe('ToolbarStrip (IMC-1.10)', () => {
  test('a labelled toolbar', () => {
    const root = mount(<ToolbarStrip label="Formatting"><button type="button">Bold</button></ToolbarStrip>);
    const strip = root.querySelector('[role="toolbar"]');
    assert({
      given: 'a page type’s tools',
      should: 'hold them in one 44px toolbar named for the page type',
      actual: [strip?.getAttribute('aria-label'), strip?.className, strip?.textContent],
      expected: ['Formatting', toolbarStripClass, 'Bold'],
    });
  });

  test('the strip’s geometry', () => {
    assert({
      given: 'the strip class',
      should: 'be 44px, flat, with a hairline under it',
      actual: ['h-toolbar-strip', 'border-b', 'border-hairline'].every((cls) => toolbarStripClass.split(' ').includes(cls)) && !toolbarStripClass.includes('shadow'),
      expected: true,
    });
  });
});

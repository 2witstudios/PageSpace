import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  segmentClass,
  segmentCountClass,
  segmentedControlClass,
} from './segmented-control-class';
import {
  renderSegmentedControl,
  segmentAfterKey,
  type Segment,
} from './segmented-control.render';

type View = 'focus' | 'tree' | 'board';

const segments: readonly Segment<View>[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'tree', label: 'Tree' },
  { value: 'board', label: 'Board', count: 4 },
];

const html = (value: View) =>
  renderToString(
    renderSegmentedControl({ label: 'View', segments, value, select: () => undefined }),
  );

const radios = (markup: string) => markup.match(/<button[^>]*>/g) ?? [];

describe('renderSegmentedControl', () => {
  test('a named radiogroup', () => {
    assert({
      given: 'a label for the control',
      should: 'render one radiogroup named by it',
      actual: html('tree').startsWith(
        `<div role="radiogroup" aria-label="View" class="${segmentedControlClass}">`,
      ),
      expected: true,
    });
  });

  test('one checked radio', () => {
    const buttons = radios(html('board'));
    assert({
      given: 'three segments with the third chosen',
      should: 'render each as a radio button and check only the chosen one',
      actual: buttons.map((button) => [
        button.includes('type="button"'),
        button.includes('role="radio"'),
        button.match(/aria-checked="(true|false)"/)?.[1],
      ]),
      expected: [
        [true, true, 'false'],
        [true, true, 'false'],
        [true, true, 'true'],
      ],
    });
  });

  test('roving tab stop', () => {
    assert({
      given: 'the second segment chosen',
      should: 'give the group a single tab stop on the checked radio',
      actual: radios(html('tree')).map((button) => button.match(/tabindex="(-?\d)"/)?.[1]),
      expected: ['-1', '0', '-1'],
    });
  });

  test('roving tab stop with nothing chosen', () => {
    const markup = renderToString(
      renderSegmentedControl<string>({
        label: 'View',
        segments,
        value: 'missing',
        select: () => undefined,
      }),
    );
    assert({
      given: 'a value that matches no segment',
      should: 'keep the group reachable through its first radio',
      actual: radios(markup).map((button) => button.match(/tabindex="(-?\d)"/)?.[1]),
      expected: ['0', '-1', '-1'],
    });
  });

  test('labels and counts', () => {
    const markup = html('focus');
    assert({
      given: 'a segment with a count and two without',
      should: 'show every label and the count after its label, as in "Board · 4"',
      actual: [
        markup.includes('>Focus</button>'),
        markup.includes('>Tree</button>'),
        markup.includes(`Board<span class="${segmentCountClass}"> · 4</span></button>`),
        (markup.match(/ · /g) ?? []).length,
      ],
      expected: [true, true, true, 1],
    });
  });

  test('styling', () => {
    const buttons = radios(html('tree'));
    assert({
      given: 'a checked and two unchecked segments',
      should: 'use the class module for each state',
      actual: buttons.map((button) => button.match(/class="([^"]*)"/)?.[1]),
      expected: [segmentClass(false), segmentClass(true), segmentClass(false)],
    });
  });
});

describe('segmentAfterKey', () => {
  const values: readonly View[] = ['focus', 'tree', 'board'];

  test('forward', () => {
    assert({
      given: 'ArrowRight or ArrowDown',
      should: 'move to the next segment, wrapping from the last to the first',
      actual: [
        segmentAfterKey(values, 'focus', 'ArrowRight'),
        segmentAfterKey(values, 'tree', 'ArrowDown'),
        segmentAfterKey(values, 'board', 'ArrowRight'),
      ],
      expected: ['tree', 'board', 'focus'],
    });
  });

  test('backward', () => {
    assert({
      given: 'ArrowLeft or ArrowUp',
      should: 'move to the previous segment, wrapping from the first to the last',
      actual: [
        segmentAfterKey(values, 'board', 'ArrowLeft'),
        segmentAfterKey(values, 'tree', 'ArrowUp'),
        segmentAfterKey(values, 'focus', 'ArrowLeft'),
      ],
      expected: ['tree', 'focus', 'board'],
    });
  });

  test('ends', () => {
    assert({
      given: 'Home or End',
      should: 'jump to the first or the last segment',
      actual: [segmentAfterKey(values, 'tree', 'Home'), segmentAfterKey(values, 'tree', 'End')],
      expected: ['focus', 'board'],
    });
  });

  test('no current segment', () => {
    assert({
      given: 'a current value that matches no segment',
      should: 'move forward to the first and backward to the last',
      actual: [
        segmentAfterKey<string>(values, 'missing', 'ArrowRight'),
        segmentAfterKey<string>(values, 'missing', 'ArrowLeft'),
      ],
      expected: ['focus', 'board'],
    });
  });

  test('other keys', () => {
    assert({
      given: 'a key the radiogroup does not handle, or no segments at all',
      should: 'move nowhere',
      actual: [
        segmentAfterKey(values, 'tree', 'Tab'),
        segmentAfterKey(values, 'tree', ' '),
        segmentAfterKey<View>([], 'tree', 'ArrowRight'),
      ],
      expected: [undefined, undefined, undefined],
    });
  });
});

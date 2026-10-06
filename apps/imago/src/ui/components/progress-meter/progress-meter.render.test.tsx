import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  progressMeterBarClass,
  progressMeterClass,
  progressMeterCountClass,
} from './progress-meter-class';
import { renderProgressMeter } from './progress-meter.render';

describe('renderProgressMeter', () => {
  test('a labelled progressbar and its count', () => {
    assert({
      given: 'one of three done',
      should:
        'render a native progressbar with value and max, named for what it counts, and a count hidden from the name',
      actual: renderToString(renderProgressMeter({ done: 1, total: 3 })),
      expected:
        `<span class="${progressMeterClass}">` +
        `<progress role="progressbar" class="${progressMeterBarClass}" value="1" max="3" aria-label="1 of 3 subtasks done"></progress>` +
        `<span class="${progressMeterCountClass}" aria-hidden="true">1/3</span>` +
        `</span>`,
    });
  });

  test('complete', () => {
    const html = renderToString(renderProgressMeter({ done: 3, total: 3 }));
    assert({
      given: 'every subtask done',
      should: 'fill the bar and say so',
      actual: [
        html.includes('value="3" max="3"'),
        html.includes('aria-label="3 of 3 subtasks done"'),
        html.includes('>3/3</span>'),
      ],
      expected: [true, true, true],
    });
  });

  test('what it counts', () => {
    const html = renderToString(renderProgressMeter({ done: 4, total: 9, unit: 'tasks' }));
    assert({
      given: 'a meter counting a list’s tasks rather than a task’s subtasks',
      should: 'name what it counts',
      actual: html.includes('aria-label="4 of 9 tasks done"'),
      expected: true,
    });
  });
});

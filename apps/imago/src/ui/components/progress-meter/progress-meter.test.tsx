// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ProgressMeter } from './progress-meter';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ProgressMeter', () => {
  test('a progressbar exposing value and max', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<ProgressMeter done={2} total={5} />));
    const bar = container.querySelector('[role="progressbar"]');
    const actual = {
      native: bar instanceof HTMLProgressElement,
      value: bar instanceof HTMLProgressElement ? bar.value : null,
      max: bar instanceof HTMLProgressElement ? bar.max : null,
      name: bar?.getAttribute('aria-label'),
      count: container.textContent,
    };
    act(() => root.unmount());
    assert({
      given: 'two of five done, mounted',
      should: 'expose one native progressbar whose value and max are the counts',
      actual,
      expected: { native: true, value: 2, max: 5, name: '2 of 5 subtasks done', count: '2/5' },
    });
  });
});

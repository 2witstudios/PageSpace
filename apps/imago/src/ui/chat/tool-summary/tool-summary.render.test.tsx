// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { toolStateClass, toolSummaryClass, toolSummaryLineClass } from './tool-summary-class';
import { toolSummary, type ToolPart } from './tool-summary';
import { renderToolSummary } from './tool-summary.render';

const dom = (part: ToolPart): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = renderToString(renderToolSummary(toolSummary(part)));
  return container;
};

describe('renderToolSummary()', () => {
  test('one line, collapsed', () => {
    const view = dom({
      type: 'tool-read_page',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { title: 'Roadmap' },
      output: { success: true },
    });
    const details = view.querySelector('details');
    const summary = details?.querySelector('summary');
    assert({
      given: 'a finished read_page call',
      should: 'show one collapsed line naming the call, its target and its state, with the detail behind it',
      actual: [
        details?.className,
        details?.hasAttribute('open'),
        details?.dataset.tool,
        summary?.className,
        [...(summary?.querySelectorAll('span') ?? [])].map((span) => span.textContent),
        summary?.querySelector('[data-state]')?.className,
        [...(details?.querySelectorAll('pre') ?? [])].map((pre) => pre.textContent),
      ],
      expected: [
        toolSummaryClass,
        false,
        'done',
        toolSummaryLineClass,
        ['Read page', 'Roadmap', 'done'],
        toolStateClass('done'),
        ['Input\n{\n  "title": "Roadmap"\n}', 'Output\n{\n  "success": true\n}'],
      ],
    });
  });

  test('failed call', () => {
    const view = dom({
      type: 'tool-read_page',
      toolCallId: 'call-1',
      state: 'output-error',
      input: { pageId: 'p1' },
      errorText: '<b>Page not found</b>',
    });
    assert({
      given: 'a call that failed with an error carrying markup',
      should: 'say failed, show the error as text under Error and no element from it',
      actual: [
        view.querySelector('[data-state]')?.textContent,
        [...view.querySelectorAll('pre')].map((pre) => pre.textContent).at(-1),
        view.querySelector('pre b'),
      ],
      expected: ['failed', 'Error\n<b>Page not found</b>', null],
    });
  });

  test('running call with no input yet', () => {
    const view = dom({ type: 'dynamic-tool', toolName: 'list_drives', toolCallId: 'c', state: 'input-streaming', input: undefined });
    assert({
      given: 'a call still receiving its input',
      should: 'say running and show no detail sections',
      actual: [view.querySelector('[data-state]')?.textContent, view.querySelectorAll('pre').length],
      expected: ['running', 0],
    });
  });
});

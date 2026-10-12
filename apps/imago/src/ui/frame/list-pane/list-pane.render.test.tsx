// @vitest-environment jsdom
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { mount, unmountAll } from '../../test-support/dom';
import { CloseSidebar } from '../controls/controls';
import { ListPane } from './list-pane';
import { renderListPane } from './list-pane.render';

const close = <button type="button" aria-label="Close sidebar" />;

describe('renderListPane()', () => {
  test('the wide list', () => {
    const html = renderToString(renderListPane({ variant: 'list', title: 'Files', close, children: null }));
    assert({
      given: 'a stage-2 list',
      should: 'be a named region at the wide width whose head ends in the close control, with no link back',
      actual: [
        html.includes('aria-label="Files"'),
        html.includes('w-list-pane'),
        html.indexOf('aria-label="Close sidebar"') < html.indexOf('</header>'),
        html.includes('<a'),
      ],
      expected: [true, true, true, false],
    });
  });

  test('a section’s own controls', () => {
    const html = renderToString(
      renderListPane({
        variant: 'list',
        title: 'Files',
        close,
        actions: <button type="button" aria-label="New page" />,
        children: null,
      }),
    );
    assert({
      given: 'a list with its own header control',
      should: 'put it in the header ahead of the close',
      actual: [
        html.includes('aria-label="New page"'),
        html.indexOf('aria-label="New page"') < html.indexOf('aria-label="Close sidebar"'),
        html.indexOf('aria-label="New page"') < html.indexOf('</header>'),
      ],
      expected: [true, true, true],
    });
  });

  test('the narrow tree', () => {
    const html = renderToString(
      renderListPane({ variant: 'tree', title: 'Files', close, children: <p data-body="">rows</p> }),
    );
    assert({
      given: 'a stage-3 tree beside an object',
      should: 'take the narrow width and render its rows in the body after the head',
      actual: [html.includes('w-tree-pane'), html.indexOf('data-body') > html.indexOf('</header>')],
      expected: [true, true],
    });
  });
});

describe('ListPane', () => {
  test('Close sidebar on every variant', () => {
    setUiState(createInitialState());
    const list = mount(<ListPane section="files" variant="list" title="Files" />);
    const tree = mount(<ListPane section="tasks" variant="tree" title="Tasks" />);
    const button = (container: HTMLElement) =>
      container.querySelector<HTMLButtonElement>('header button[aria-label="Close sidebar"]');
    const found = [button(list) !== null, button(tree) !== null];
    act(() => button(list)?.click());
    const collapsed = getUiState().resources.collapsedSections;
    unmountAll();

    assert({
      given: 'the wide list and the narrow tree, and Close sidebar clicked on Files',
      should: 'always offer a Close sidebar button that collapses its section through the store',
      actual: [found, collapsed],
      expected: [[true, true], ['files']],
    });
  });

  test('icon semantics', () => {
    const html = renderToString(<CloseSidebar section="files" />);
    assert({
      given: 'the Close sidebar icon',
      should: 'be lucide at stroke 1.5 / 16px, hidden from assistive technology',
      actual: [html.includes('stroke-width="1.5"'), html.includes('width="16"'), html.includes('aria-hidden="true"')],
      expected: [true, true, true],
    });
  });
});

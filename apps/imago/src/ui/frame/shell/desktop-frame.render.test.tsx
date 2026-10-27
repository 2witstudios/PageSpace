import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { columnsFor } from '../stage/columns';
import { isHideableSection, paneLayout, stageFor } from '../stage/stage';
import { renderTabBar } from '../tabs/tab-bar.render';
import { renderShell } from './shell.render';

const shell = (desktopFrame: boolean | undefined): string => {
  const stage = stageFor('/drive-1');
  const columns = columnsFor(stage, { paneCollapsed: isHideableSection(stage.section), imagoCollapsed: false, imagoClosed: false });
  return renderToString(
    renderShell({
      stage,
      hydrated: true,
      layout: paneLayout(stage, { collapsedSections: [] }),
      columns,
      desktopFrame,
      rail: h('p', null, 'rail'),
      banner: h('p', null, 'banner'),
      tabBar: h('p', null, 'tabs'),
      list: h('p', null, 'list'),
      object: h('p', null, 'object'),
      chat: h('p', null, 'chat'),
      empty: h('p', null, 'empty'),
      palette: h('p', null, 'palette'),
    }),
  );
};

describe('renderShell() under the desktop app', () => {
  test('the frame root carries the marker only when desktopFrame is set', () => {
    assert({
      given: 'the shell rendered with and without the desktop frame',
      should: 'mark the root with data-desktop-frame only for the desktop app',
      actual: [shell(true).includes('data-desktop-frame=""'), shell(false).includes('data-desktop-frame'), shell(undefined).includes('data-desktop-frame')],
      expected: [true, false, false],
    });
  });

  test('the spine is a drag region, so its top sits under the traffic lights', () => {
    assert({
      given: 'the shell rendered under the desktop app',
      should: 'mark the Sections spine as a drag region',
      actual: /<nav[^>]*aria-label="Sections"[^>]*data-desktop-drag=""/.test(shell(true)),
      expected: true,
    });
  });
});

describe('renderTabBar() drag region', () => {
  test('the tab strip is a drag region, and the Back, Forward and New tab controls stay clickable', () => {
    const html = renderToString(
      renderTabBar({
        tabs: h('div', { role: 'tab' }, 'Plan'),
        canBack: false,
        canForward: false,
        onBack: () => {},
        onForward: () => {},
        onNew: () => {},
      }),
    );
    assert({
      given: 'the tab bar rendered with one open tab',
      should: 'mark the tablist as a drag region without marking the tabs or buttons',
      actual: [/role="tablist"[^>]*data-desktop-drag=""/.test(html), html.split('data-desktop-drag').length - 1],
      expected: [true, 1],
    });
  });
});

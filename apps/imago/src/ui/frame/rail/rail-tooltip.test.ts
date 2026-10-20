// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { attachRailTooltips } from './rail-tooltip';

/** A spine tile with its tooltip, as renderRailButton draws it. */
const tile = (label: string): HTMLElement => {
  const button = document.createElement('button');
  button.className = 'group relative';
  button.innerHTML = `<span data-rail-tooltip="">${label}</span>`;
  document.body.append(button);
  button.getBoundingClientRect = () => ({ top: 100, height: 40, right: 60, bottom: 140, left: 20, width: 40, x: 20, y: 100, toJSON: () => ({}) });
  return button;
};

describe('attachRailTooltips()', () => {
  let detach: () => void;

  beforeEach(() => {
    detach = attachRailTooltips(document);
  });

  afterEach(() => {
    detach();
    document.body.innerHTML = '';
  });

  test('pointer enter', () => {
    const button = tile('Files');
    const tip = button.querySelector<HTMLElement>('[data-rail-tooltip]')!;
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    assert({
      given: 'a tile whose pointer enters it',
      should: 'place its tooltip beside the tile, centred vertically',
      actual: [tip.style.top, tip.style.left],
      expected: ['120px', '68px'],
    });
  });

  test('focus', () => {
    const button = tile('Files');
    const tip = button.querySelector<HTMLElement>('[data-rail-tooltip]')!;
    button.dispatchEvent(new Event('focusin', { bubbles: true }));
    assert({
      given: 'a tile that takes focus',
      should: 'place its tooltip the same way',
      actual: [tip.style.top, tip.style.left],
      expected: ['120px', '68px'],
    });
  });

  test('leaving the tile, then scrolling', () => {
    const button = tile('Files');
    const tip = button.querySelector<HTMLElement>('[data-rail-tooltip]')!;
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    button.getBoundingClientRect = () => ({ top: 300, height: 40, right: 60, bottom: 340, left: 20, width: 40, x: 20, y: 300, toJSON: () => ({}) });
    button.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    document.dispatchEvent(new Event('scroll'));
    assert({
      given: 'the pointer has left the tile and the page scrolls',
      should: 'leave the tooltip where it was rather than re-placing it',
      actual: tip.style.top,
      expected: '120px',
    });
  });

  test('resize while tracked', () => {
    const button = tile('Files');
    const tip = button.querySelector<HTMLElement>('[data-rail-tooltip]')!;
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    button.getBoundingClientRect = () => ({ top: 200, height: 40, right: 60, bottom: 240, left: 20, width: 40, x: 20, y: 200, toJSON: () => ({}) });
    window.dispatchEvent(new Event('resize'));
    assert({
      given: 'the viewport resizes while the tile is hovered',
      should: 'move the tooltip with the tile',
      actual: tip.style.top,
      expected: '220px',
    });
  });

  test('after detaching', () => {
    const button = tile('Files');
    const tip = button.querySelector<HTMLElement>('[data-rail-tooltip]')!;
    detach();
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    assert({
      given: 'listeners removed',
      should: 'leave the tooltip where it was',
      actual: tip.style.top,
      expected: '',
    });
  });
});

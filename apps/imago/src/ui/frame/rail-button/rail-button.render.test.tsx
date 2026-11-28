import Link from 'next/link';
import type { MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { spineCountClass, spineMarkerClass, spineTileClass } from './rail-button-class';
import { renderRailButton, renderSpineCount, type RailButtonRenderProps } from './rail-button.render';

const files: RailButtonRenderProps = {
  icon: 'files',
  label: 'Files',
  href: '/drive-1/files',
  current: null,
  unread: 0,
};

type LinkProps = {
  readonly href: string;
  readonly prefetch?: boolean;
  readonly onClick?: (event: MouseEvent) => void;
  readonly 'aria-current'?: string;
  readonly 'aria-label'?: string;
};

const linkOf = (props: RailButtonRenderProps) => {
  const link = findElement<LinkProps>(renderRailButton(props), (element) => element.type === Link);
  if (link === undefined) throw new Error('no Link');
  return link.props;
};

describe('renderRailButton()', () => {
  test('a section link with full prefetch', () => {
    const link = linkOf(files);
    assert({
      given: 'a rail item with a destination',
      should: 'render a Next link to it that prefetches the full route, named by its label',
      actual: [link.href, link.prefetch, link['aria-label'], link['aria-current'], link.onClick],
      expected: ['/drive-1/files', true, 'Files', undefined, undefined],
    });
  });

  test('the active item', () => {
    const html = renderToStaticMarkup(renderRailButton({ ...files, current: 'page' }));
    assert({
      given: 'the item whose own URL is open',
      should: 'mark the link aria-current="page", fill its tile and draw the marker',
      actual: [
        linkOf({ ...files, current: 'page' })['aria-current'],
        html.includes('aria-current="page"'),
        html.includes(`class="${spineTileClass('small', true)}"`),
        html.includes(`<span class="${spineMarkerClass('small')}" aria-hidden="true"></span>`),
      ],
      expected: ['page', true, true, true],
    });
  });

  test('inside the active section', () => {
    const html = renderToStaticMarkup(renderRailButton({ ...files, current: 'section' }));
    assert({
      given: 'a page open inside the item’s section, not the item’s own URL',
      should: 'mark the link aria-current="true", not "page", and still fill its tile',
      actual: [linkOf({ ...files, current: 'section' })['aria-current'], html.includes(`class="${spineTileClass('small', true)}"`)],
      expected: ['true', true],
    });
  });

  test('an unread count', () => {
    const html = renderToStaticMarkup(
      renderRailButton({ icon: 'messages', label: 'Messages', href: '/drive-1/messages', current: null, unread: 3 }),
    );
    assert({
      given: 'three unread messages',
      should: 'draw the amber count and carry it in the control’s name',
      actual: [
        html.includes('aria-label="Messages, 3 unread"'),
        html.includes(`<span class="${spineCountClass}" aria-hidden="true">3</span>`),
      ],
      expected: [true, true],
    });
  });

  test('nothing unread', () => {
    const html = renderToStaticMarkup(renderRailButton(files));
    assert({
      given: 'a zero count',
      should: 'draw no count and keep the plain name',
      actual: [html.includes('bg-notice'), html.includes('aria-label="Files"')],
      expected: [false, true],
    });
  });

  test('reopening a collapsed section', () => {
    const onReopen = vi.fn();
    const preventDefault = vi.fn();
    const link = linkOf({ ...files, current: 'section', onReopen });
    link.onClick?.({ preventDefault } as unknown as MouseEvent);
    assert({
      given: 'the active item while its section’s list is hidden, clicked',
      should: 'stay on the page and reopen the list instead',
      actual: [preventDefault.mock.calls.length, onReopen.mock.calls.length],
      expected: [1, 1],
    });
  });

  test('no drive to link to', () => {
    const html = renderToStaticMarkup(renderRailButton({ ...files, href: null }));
    assert({
      given: 'an item with no destination',
      should: 'render a disabled button, not a link to nowhere',
      actual: [
        html.startsWith(`<button type="button" class="${spineTileClass('small', false, false)}" aria-label="Files" disabled="">`),
        html.includes('href'),
      ],
      expected: [true, false],
    });
  });

  test('the tooltip', () => {
    const html = renderToStaticMarkup(renderRailButton(files));
    assert({
      given: 'any rail item',
      should: 'carry its label in a tooltip hidden from assistive technology',
      actual: /<span class="pointer-events-none[^"]*" aria-hidden="true" data-rail-tooltip="">Files<\/span>/.test(html),
      expected: true,
    });
  });

  test('a section tile', () => {
    const html = renderToStaticMarkup(renderRailButton({ ...files, size: 'primary', current: 'page' }));
    assert({
      given: 'one of the four sections, active',
      should: 'draw the 48px tile with the taller marker and a 20px icon',
      actual: [
        html.includes(`class="${spineTileClass('primary', true)}"`),
        html.includes(`class="${spineMarkerClass('primary')}"`),
        /<svg[^>]*width="20"/.test(html),
      ],
      expected: [true, true, true],
    });
  });

  test('the size by default', () => {
    const html = renderToStaticMarkup(renderRailButton(files));
    assert({
      given: 'no size',
      should: 'draw the small tool tile with an 18px icon and no marker while inactive',
      actual: [html.includes(`class="${spineTileClass('small', false)}"`), /<svg[^>]*width="18"/.test(html), html.includes('bg-spine-marker')],
      expected: [true, true, false],
    });
  });
});

describe('renderSpineCount()', () => {
  test('counts', () => {
    const html = (count: number): string => renderToStaticMarkup(<>{renderSpineCount(count)}</>);
    assert({
      given: 'zero, a few and more than 99 unread',
      should: 'draw nothing at zero, the number, then cap it at 99+',
      actual: [html(0), html(7), html(120)],
      expected: [
        '',
        `<span class="${spineCountClass}" aria-hidden="true">7</span>`,
        `<span class="${spineCountClass}" aria-hidden="true">99+</span>`,
      ],
    });
  });
});

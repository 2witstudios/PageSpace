import Link from 'next/link';
import type { MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { railChipClass, railHitClass } from './rail-button-class';
import { renderRailButton, type RailButtonRenderProps } from './rail-button.render';

const files: RailButtonRenderProps = {
  icon: 'files',
  label: 'Files',
  href: '/drive-1/files',
  active: false,
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
    const html = renderToStaticMarkup(renderRailButton({ ...files, active: true }));
    assert({
      given: 'the item for the current section',
      should: 'mark the link aria-current="page" and tint its chip',
      actual: [
        linkOf({ ...files, active: true })['aria-current'],
        html.includes('aria-current="page"'),
        html.includes(`class="${railChipClass(true, true)}"`),
      ],
      expected: ['page', true, true],
    });
  });

  test('an unread count', () => {
    const html = renderToStaticMarkup(
      renderRailButton({ icon: 'messages', label: 'Messages', href: '/drive-1/messages', active: false, unread: 3 }),
    );
    assert({
      given: 'three unread messages',
      should: 'draw the accent count and carry it in the control’s name',
      actual: [
        html.includes('aria-label="Messages, 3 unread"'),
        /<span class="[^"]*bg-accent[^"]*text-accent-ink[^"]*absolute top-0 right-0" aria-hidden="true">3<\/span>/.test(html),
      ],
      expected: [true, true],
    });
  });

  test('nothing unread', () => {
    const html = renderToStaticMarkup(renderRailButton(files));
    assert({
      given: 'a zero count',
      should: 'draw no count and keep the plain name',
      actual: [html.includes('bg-accent '), html.includes('aria-label="Files"')],
      expected: [false, true],
    });
  });

  test('reopening a collapsed section', () => {
    const onReopen = vi.fn();
    const preventDefault = vi.fn();
    const link = linkOf({ ...files, active: true, onReopen });
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
      actual: [html.startsWith(`<button type="button" class="${railHitClass(false)}" aria-label="Files" disabled="">`), html.includes('href')],
      expected: [true, false],
    });
  });

  test('the tooltip', () => {
    const html = renderToStaticMarkup(renderRailButton(files));
    assert({
      given: 'any rail item',
      should: 'carry its label in a tooltip hidden from assistive technology',
      actual: /<span class="pointer-events-none[^"]*" aria-hidden="true">Files<\/span>/.test(html),
      expected: true,
    });
  });
});

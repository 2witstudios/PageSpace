// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { driveInitial, renderDriveMark, type DriveMarkDrive } from './drive-mark.render';

const SHAPE = 'size-spine-brand rounded-spine-brand';
const FILL = 'bg-spine-tile text-spine';

const mark = (drive: DriveMarkDrive) => {
  const parsed = document.createElement('template');
  parsed.innerHTML = renderToStaticMarkup(renderDriveMark({ drive, shape: SHAPE, fill: FILL }));
  const tile = parsed.content.querySelector('[data-drive-mark]');
  return { tile, className: tile?.getAttribute('class') ?? '', img: tile?.querySelector('img')?.getAttribute('src') ?? null, text: tile?.textContent };
};

describe('renderDriveMark()', () => {
  test('a drive that chose nothing', () => {
    const { className, img, text } = mark({ name: 'alpha' });
    assert({
      given: 'a plain drive',
      should: 'show its initial on the surface\'s own fill',
      actual: { surfaceFill: className.includes(FILL), img, text },
      expected: { surfaceFill: true, img: null, text: 'A' },
    });
  });

  test('a color', () => {
    const { className, text } = mark({ name: 'Alpha', color: 'teal' });
    assert({
      given: 'a drive that picked teal',
      should: 'paint its tile teal instead of the surface fill, never both',
      actual: { teal: className.includes('bg-mark-teal'), surface: className.includes('bg-spine-tile'), text },
      expected: { teal: true, surface: false, text: 'A' },
    });
  });

  test('a color outside the palette', () => {
    assert({
      given: 'a stored value that is not a palette key',
      should: 'fall back to the surface fill',
      actual: mark({ name: 'Alpha', color: '#ff0000' }).className.includes(FILL),
      expected: true,
    });
  });

  test('precedence', () => {
    assert({
      given: 'the drive\'s image, its color and its org\'s image in turn',
      should: 'take the drive\'s image first, its color over the org\'s image, and the org\'s image only for a drive with neither',
      actual: [
        mark({ name: 'A', avatarUrl: '/api/drives/d/avatar/avatar-1.png', orgAvatarUrl: '/api/orgs/o/avatar/avatar-2.png' }).img,
        mark({ name: 'A', color: 'red', orgAvatarUrl: '/api/orgs/o/avatar/avatar-2.png' }).img,
        mark({ name: 'A', orgAvatarUrl: '/api/orgs/o/avatar/avatar-2.png' }).img,
      ],
      expected: ['/api/drives/d/avatar/avatar-1.png', null, '/api/orgs/o/avatar/avatar-2.png'],
    });
  });

  test('the initial', () => {
    assert({
      given: 'names with spaces, emoji and nothing',
      should: 'take the first whole grapheme, upper-cased, and a question mark for a blank name',
      actual: [driveInitial('  élan'), driveInitial('🚀 Rocket'), driveInitial('   ')],
      expected: ['É', '🚀', '?'],
    });
  });
});

describe('renderDriveMark() in the browser', () => {
  test('an image that failed, then a new one', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const draw = (avatarUrl: string) =>
      act(() => root.render(renderDriveMark({ drive: { name: 'Alpha', avatarUrl }, shape: SHAPE, fill: FILL })));
    draw('/api/drives/d/avatar/avatar-bad.png');
    act(() => {
      container.querySelector('img')?.dispatchEvent(new Event('error'));
    });
    const failedHidden = container.querySelector('img')?.hidden;
    draw('/api/drives/d/avatar/avatar-good.png');
    const replacement = container.querySelector('img');
    assert({
      given: 'an image that failed to load, then the drive\'s new image',
      should: 'hide the failed one but show the new one',
      actual: { failedHidden, newHidden: replacement?.hidden, src: replacement?.getAttribute('src') },
      expected: { failedHidden: true, newHidden: false, src: '/api/drives/d/avatar/avatar-good.png' },
    });
    act(() => root.unmount());
    container.remove();
  });
});

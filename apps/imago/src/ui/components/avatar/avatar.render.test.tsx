import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  avatarClass,
  avatarImageClass,
  avatarInitialsClass,
  avatarPresenceClass,
} from './avatar-class';
import { renderAvatar } from './avatar.render';
import { presenceDotClass } from '../presence-dot/presence-dot-class';

describe('renderAvatar()', () => {
  test('initials', () => {
    assert({
      given: 'a person with no image at the default size',
      should: 'draw two initials, hidden, and name the person for screen readers',
      actual: renderToString(renderAvatar({ name: 'Maya Singh' })),
      expected: `<span class="${avatarClass('md')}"><span class="${avatarInitialsClass}" aria-hidden="true">MS</span><span class="sr-only">Maya Singh</span></span>`,
    });
  });

  test('a stacked face', () => {
    assert({
      given: 'a face in the 24px overlapping stack',
      should: 'draw one letter so the overlap never clips it, keeping the full name',
      actual: renderToString(renderAvatar({ name: 'noah hart', size: 'stack' })),
      expected: `<span class="${avatarClass('stack')}"><span class="${avatarInitialsClass}" aria-hidden="true">N</span><span class="sr-only">noah hart</span></span>`,
    });
  });

  test('an image', () => {
    assert({
      given: 'a person with an image',
      should:
        'fill the face with a decorative image and keep the name (React hoists a preload for it)',
      actual: renderToString(
        renderAvatar({ name: 'Daniel Kim', src: '/a.png', size: 'sm' }),
      ),
      expected: `<link rel="preload" as="image" href="/a.png"/><span class="${avatarClass('sm')}"><img src="/a.png" alt="" class="${avatarImageClass}"/><span class="sr-only">Daniel Kim</span></span>`,
    });
  });

  test('presence', () => {
    assert({
      given: 'a person who is online',
      should: 'seat a named presence dot on the edge of the face',
      actual: renderToString(
        renderAvatar({ name: 'Maya Singh', presence: 'online' }),
      ),
      expected: `<span class="${avatarClass('md')}"><span class="${avatarInitialsClass}" aria-hidden="true">MS</span><span class="${avatarPresenceClass}"><span class="${presenceDotClass('online')}" role="img" aria-label="Online"></span></span><span class="sr-only">Maya Singh</span></span>`,
    });
  });

  test('an agent', () => {
    const html = renderToString(
      renderAvatar({ name: 'research-worker', agent: true, size: 'stack' }),
    );
    assert({
      given: 'an AI agent',
      should:
        'draw the hidden bot glyph at stroke 1.5 on the accent tint, marked as an agent and named',
      actual: [
        html.startsWith(`<span class="${avatarClass('stack', 'agent')}" data-agent="true"><svg`),
        html.includes('lucide-bot'),
        /<svg[^>]* width="12"/.test(html),
        /<svg[^>]* stroke-width="1.5"/.test(html),
        /<svg[^>]* aria-hidden="true"/.test(html),
        html.endsWith('<span class="sr-only">research-worker</span></span>'),
      ],
      expected: [true, true, true, true, true, true],
    });
  });

  test('a blank name', () => {
    assert({
      given: 'a name of only spaces',
      should: 'draw no initials rather than a stray character',
      actual: renderToString(renderAvatar({ name: '  ', size: 'xs' })),
      expected: `<span class="${avatarClass('xs')}"><span class="${avatarInitialsClass}" aria-hidden="true"></span><span class="sr-only">  </span></span>`,
    });
  });
});

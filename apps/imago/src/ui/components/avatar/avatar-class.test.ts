import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  avatarClass,
  avatarImageClass,
  avatarInitialsClass,
  avatarPresenceClass,
  avatarSizes,
} from './avatar-class';

const base =
  'relative inline-flex shrink-0 items-center justify-center rounded-round font-medium';
const person = 'bg-surface-overlay text-ink-muted';
const agent = 'bg-accent-soft text-accent';

describe('avatarClass()', () => {
  test('sizes', () => {
    assert({
      given: 'each avatar size for a person',
      should:
        'add its size step, and ring the 24px stacked face in the canvas so an overlap never clips the one beneath',
      actual: avatarSizes.map((size) => avatarClass(size)),
      expected: [
        `${base} size-avatar-stack border-2 border-background text-2xs ${person}`,
        `${base} size-avatar-xs border border-border text-2xs ${person}`,
        `${base} size-avatar-sm border border-border text-xs ${person}`,
        `${base} size-avatar-md border border-border text-sm ${person}`,
        `${base} size-avatar-lg border border-border text-md ${person}`,
      ],
    });
  });

  test('agent tone', () => {
    assert({
      given: 'an agent avatar',
      should: 'draw it on the accent tint instead of the neutral, never both',
      actual: avatarClass('stack', 'agent'),
      expected: `${base} size-avatar-stack border-2 border-background text-2xs ${agent}`,
    });
  });

  test('never red', () => {
    assert({
      given: 'every size and tone',
      should: 'never use the red live color',
      actual: avatarSizes
        .flatMap((size) => [avatarClass(size), avatarClass(size, 'agent')])
        .filter((list) => /\b(bg|text|border)-live/.test(list)),
      expected: [],
    });
  });
});

describe('avatar part classes', () => {
  test('image, initials and presence slot', () => {
    assert({
      given: 'the parts inside an avatar',
      should:
        'fill the round face with the image, space the initials, and seat the presence dot on the lower-right edge',
      actual: [avatarImageClass, avatarInitialsClass, avatarPresenceClass],
      expected: [
        'size-full rounded-round object-cover',
        'tracking-wide',
        'absolute -right-avatar-presence -bottom-avatar-presence inline-flex',
      ],
    });
  });
});

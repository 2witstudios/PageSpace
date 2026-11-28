import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createThemeController, createTransition } from './theme-controller';
import type { ThemePreference } from './theme-preference';

/**
 * Records every side effect in call order; the transition runs inline and
 * the cookie jar is shared, like the tabs of one browser.
 */
const createRecorder = ({
  jar = { cookies: '' },
  initial = 'system' as ThemePreference,
  domain = undefined as string | undefined,
} = {}) => {
  const calls: string[] = [];
  const controller = createThemeController({
    initial,
    domain,
    apply: (preference) => calls.push(`apply ${preference}`),
    writeCookie: (cookie) => {
      jar.cookies = cookie.split(';')[0] ?? '';
      calls.push(`cookie ${cookie}`);
    },
    readCookies: () => jar.cookies,
    writeStorage: (preference) => calls.push(`storage ${preference}`),
    announce: () => calls.push('announce'),
    transition: (update) => {
      calls.push('transition');
      update();
    },
  });
  return { calls, controller };
};

describe('createThemeController.select', () => {
  test('persists for both apps, applies in a transition, then tells other tabs', () => {
    const { calls, controller } = createRecorder();
    controller.select('dark');

    assert({
      given: 'the viewer choosing dark',
      should:
        "write classic's cookie and next-themes storage, apply in place, and announce",
      actual: calls,
      expected: [
        'cookie theme=dark; path=/; max-age=31536000; SameSite=Lax',
        'storage dark',
        'transition',
        'apply dark',
        'announce',
      ],
    });
  });

  test('scopes the cookie to the shared domain', () => {
    const { calls, controller } = createRecorder({ domain: '.pagespace.ai' });
    controller.select('light');

    assert({
      given: 'a cookie domain',
      should: 'write the cookie on that domain, as classic does',
      actual: calls[0],
      expected:
        'cookie theme=light; path=/; max-age=31536000; SameSite=Lax; domain=.pagespace.ai',
    });
  });
});

describe('createThemeController with cookies blocked', () => {
  /** A browser that silently drops cookie writes. */
  const createBlocked = () => {
    const calls: string[] = [];
    const controller = createThemeController({
      initial: 'system',
      domain: undefined,
      apply: (preference) => calls.push(`apply ${preference}`),
      writeCookie: () => {},
      readCookies: () => '',
      writeStorage: (preference) => calls.push(`storage ${preference}`),
      announce: () => calls.push('announce'),
      transition: (update) => update(),
    });
    return { calls, controller };
  };

  test('keeps a switch for this tab without announcing it', () => {
    const { calls, controller } = createBlocked();
    controller.select('light');

    assert({
      given: 'a switch whose cookie write did not stick',
      should: 'apply it here but not tell tabs that cannot read it',
      actual: calls,
      expected: ['storage light', 'apply light'],
    });
  });

  test('does not revert the switch when the tab is shown again', () => {
    const { calls, controller } = createBlocked();
    controller.select('light');
    const synced = controller.sync();

    assert({
      given: 'a re-sync after an unsaved switch',
      should: 'keep the chosen theme instead of the cookie default',
      actual: { synced, calls },
      expected: { synced: 'light', calls: ['storage light', 'apply light'] },
    });
  });
});

describe('createThemeController.sync', () => {
  test('applies the preference classic or another tab saved', () => {
    const jar = { cookies: 'session=abc; theme=dark' };
    const { calls, controller } = createRecorder({ jar });
    const synced = controller.sync();

    assert({
      given: 'a cookie switched to dark elsewhere',
      should: 'apply it without re-persisting or announcing',
      actual: { synced, calls },
      expected: { synced: 'dark', calls: ['transition', 'apply dark'] },
    });
  });

  test('never applies a stale choice from a delayed announcement', () => {
    const jar = { cookies: '' };
    const first = createRecorder({ jar });
    const second = createRecorder({ jar });
    first.controller.select('dark');
    second.controller.select('light');
    // The first tab's announcement arrives late, after the second's switch.
    const synced = [second.controller.sync(), first.controller.sync()];

    assert({
      given: 'two tabs switching close together, announcements out of order',
      should: 'converge every tab on the last write',
      actual: synced,
      expected: ['light', 'light'],
    });
  });

  test('falls back to system when the cookie was cleared', () => {
    const { calls, controller } = createRecorder({
      jar: { cookies: 'other=1' },
      initial: 'light',
    });

    assert({
      given: 'a light tab syncing after the theme cookie was cleared',
      should: "apply system, classic's default",
      actual: { synced: controller.sync(), calls },
      expected: { synced: 'system', calls: ['transition', 'apply system'] },
    });
  });

  test('leaves the page alone when nothing changed', () => {
    const { calls, controller } = createRecorder({
      jar: { cookies: 'theme=light' },
      initial: 'light',
    });
    controller.sync();

    assert({
      given: 'a tab shown again whose theme already matches the cookie',
      should: 'skip the transition and the apply',
      actual: calls,
      expected: [],
    });
  });
});

describe('createTransition', () => {
  test('wraps the update in a view transition when motion is allowed', () => {
    const calls: string[] = [];
    createTransition({
      startViewTransition: (update) => {
        calls.push('view transition');
        update();
      },
      prefersReducedMotion: () => false,
    })(() => calls.push('update'));

    assert({
      given: 'view transition support and no reduced-motion preference',
      should: 'run the update inside the view transition',
      actual: calls,
      expected: ['view transition', 'update'],
    });
  });

  test('updates directly under reduced motion or without support', () => {
    const calls: string[] = [];
    createTransition({
      startViewTransition: () => calls.push('view transition'),
      prefersReducedMotion: () => true,
    })(() => calls.push('reduced'));
    createTransition({
      startViewTransition: undefined,
      prefersReducedMotion: () => false,
    })(() => calls.push('unsupported'));

    assert({
      given: 'a reduced-motion preference, then a browser without view transitions',
      should: 'run each update directly',
      actual: calls,
      expected: ['reduced', 'unsupported'],
    });
  });
});

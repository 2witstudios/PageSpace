import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createTextSizeController } from './text-size-controller';
import type { TextSize } from './text-size-preference';

/** Records every side effect in call order; the cookie jar is shared, like the tabs of one browser. */
const createRecorder = ({
  jar = { cookies: '' },
  initial = 'default' as TextSize,
  domain = undefined as string | undefined,
} = {}) => {
  const calls: string[] = [];
  const controller = createTextSizeController({
    initial,
    domain,
    apply: (size) => calls.push(`apply ${size}`),
    writeCookie: (cookie) => {
      jar.cookies = cookie.split(';')[0] ?? '';
      calls.push(`cookie ${cookie}`);
    },
    readCookies: () => jar.cookies,
    announce: () => calls.push('announce'),
  });
  return { calls, controller };
};

describe('createTextSizeController.select', () => {
  test('persists, applies in place, then tells other tabs', () => {
    const { calls, controller } = createRecorder();
    controller.select('large');

    assert({
      given: 'the viewer choosing large',
      should: 'write the cookie, apply it, and announce',
      actual: calls,
      expected: ['cookie imago-text-size=large; path=/; max-age=31536000; SameSite=Lax', 'apply large', 'announce'],
    });
  });

  test('scopes the cookie to the shared domain', () => {
    const { calls, controller } = createRecorder({ domain: '.pagespace.ai' });
    controller.select('small');

    assert({
      given: 'a cookie domain',
      should: 'write the cookie on that domain',
      actual: calls[0],
      expected: 'cookie imago-text-size=small; path=/; max-age=31536000; SameSite=Lax; domain=.pagespace.ai',
    });
  });
});

describe('createTextSizeController with cookies blocked', () => {
  const createBlocked = () => {
    const calls: string[] = [];
    const controller = createTextSizeController({
      initial: 'default',
      domain: undefined,
      apply: (size) => calls.push(`apply ${size}`),
      writeCookie: () => {},
      readCookies: () => '',
      announce: () => calls.push('announce'),
    });
    return { calls, controller };
  };

  test('keeps a choice for this tab without announcing it', () => {
    const { calls, controller } = createBlocked();
    controller.select('larger');

    assert({
      given: 'a choice whose cookie write did not stick',
      should: 'apply it here but not tell tabs that cannot read it',
      actual: calls,
      expected: ['apply larger'],
    });
  });

  test('does not revert the choice when the tab is shown again', () => {
    const { calls, controller } = createBlocked();
    controller.select('larger');
    const synced = controller.sync();

    assert({
      given: 'a re-sync after an unsaved choice',
      should: 'keep the chosen size instead of the cookie default',
      actual: { synced, calls },
      expected: { synced: 'larger', calls: ['apply larger'] },
    });
  });
});

describe('createTextSizeController.sync', () => {
  test('applies the size another tab saved', () => {
    const { calls, controller } = createRecorder({ jar: { cookies: 'session=abc; imago-text-size=large' } });
    const synced = controller.sync();

    assert({
      given: 'a cookie switched to large elsewhere',
      should: 'apply it without re-persisting or announcing',
      actual: { synced, calls },
      expected: { synced: 'large', calls: ['apply large'] },
    });
  });

  test('never applies a stale choice from a delayed announcement', () => {
    const jar = { cookies: '' };
    const first = createRecorder({ jar });
    const second = createRecorder({ jar });
    first.controller.select('small');
    second.controller.select('larger');
    const synced = [second.controller.sync(), first.controller.sync()];

    assert({
      given: 'two tabs choosing close together, announcements out of order',
      should: 'converge every tab on the last write',
      actual: synced,
      expected: ['larger', 'larger'],
    });
  });

  test('falls back to default when the cookie was cleared', () => {
    const { calls, controller } = createRecorder({ jar: { cookies: 'other=1' }, initial: 'large' });

    assert({
      given: 'a large tab syncing after the cookie was cleared',
      should: 'apply the default size',
      actual: { synced: controller.sync(), calls },
      expected: { synced: 'default', calls: ['apply default'] },
    });
  });

  test('leaves the page alone when nothing changed', () => {
    const { calls, controller } = createRecorder({ jar: { cookies: 'imago-text-size=small' }, initial: 'small' });
    controller.sync();

    assert({
      given: 'a tab shown again whose size already matches the cookie',
      should: 'apply nothing',
      actual: calls,
      expected: [],
    });
  });
});

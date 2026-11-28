// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { stageFor } from '../stage/stage';
import { renderPhoneShell } from './phone-shell.render';

afterEach(unmountAll);

const shell = (bar: boolean) =>
  mount(
    renderPhoneShell({
      stage: stageFor('/d1/files'),
      hydrated: true,
      screen: h('p', null, 'screen'),
      ask: null,
      bar: bar ? h('nav', { 'data-slot': 'phone-bar' }) : null,
      palette: null,
    }),
  );

const classesOf = (element: Element | null | undefined): string[] => element?.getAttribute('class')?.split(' ') ?? [];

describe('renderPhoneShell() safe areas', () => {
  test('the frame clears the notch and follows the dynamic viewport', () => {
    const frame = shell(true).querySelector('[data-tier="phone"]');
    assert({
      given: 'the phone frame',
      should: 'pad by the top and side insets and fill 100dvh',
      actual: [classesOf(frame).includes('phone-safe-frame'), classesOf(frame).includes('h-dvh')],
      expected: [true, true],
    });
  });

  test('only a barless screen clears the home indicator itself', () => {
    assert({
      given: 'a screen with and without the bottom bar',
      should: 'leave the inset to the bar, or pad the screen when there is none',
      actual: [
        classesOf(shell(true).querySelector('main')).includes('phone-safe-bottom'),
        classesOf(shell(false).querySelector('main')).includes('phone-safe-bottom'),
      ],
      expected: [false, true],
    });
  });
});

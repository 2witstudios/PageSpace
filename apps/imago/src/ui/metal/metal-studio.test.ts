// @vitest-environment jsdom
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { isDarkPage, linearOf, readStudio, studioGains } from './metal-studio';

describe('linearOf()', () => {
  test('sRGB bytes', () => {
    assert({
      given: 'black, white and mid-grey bytes',
      should: 'return linear light',
      actual: linearOf([0, 255, 128]).map((v) => Math.round(v * 1000) / 1000),
      expected: [0, 1, 0.22],
    });
  });
});

describe('isDarkPage()', () => {
  test("the house pages", () => {
    assert({
      given: "PageSpace's light page and its dark page",
      should: 'tell them apart',
      actual: [isDarkPage(linearOf([253, 253, 254])), isDarkPage(linearOf([22, 22, 22]))],
      expected: [false, true],
    });
  });
});

describe('studioGains()', () => {
  test('per theme', () => {
    assert({
      given: 'a light page, then a dark one',
      should: 'reflect more on light so it reads as silver, and drop the contact shadow on dark',
      actual: [studioGains(false), studioGains(true)],
      expected: [
        { keyGain: 2.2, pageGain: 1, reflect: 0.86, shadow: 0.2 },
        { keyGain: 2.2, pageGain: 1.15, reflect: 0.6, shadow: 0 },
      ],
    });
  });
});

describe('readStudio()', () => {
  test('no 2D canvas to resolve colours', () => {
    const studio = readStudio(document);
    assert({
      given: 'a document that cannot resolve colours to bytes (jsdom has no canvas)',
      should: 'read black and use the dark studio, leaving no probe behind',
      actual: [studio.sky, studio.floor, studio.reflect, document.body.children.length],
      expected: [[0, 0, 0], [0, 0, 0], 0.6, 0],
    });
  });
});

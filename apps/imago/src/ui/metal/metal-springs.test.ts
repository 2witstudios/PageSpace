import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { MOODS } from './metal-mood';
import { kick, makeSprings, orbBalls, stepSprings } from './metal-springs';

const round = (values: ArrayLike<number>) => Array.from(values, (v) => Math.round(v * 1000) / 1000);

describe('stepSprings()', () => {
  test('a change of mood', () => {
    let springs = makeSprings(MOODS.idle);
    let peak = springs.speed.x;
    for (let i = 0; i < 600; i++) {
      springs = stepSprings(springs, MOODS.thinking, 1 / 120);
      peak = Math.max(peak, springs.speed.x);
    }
    assert({
      given: 'idle springs chasing thinking for five seconds',
      should: 'overshoot like gel, then settle on the target',
      actual: [peak > MOODS.thinking.speed, Math.abs(springs.speed.x - MOODS.thinking.speed) < 0.001],
      expected: [true, true],
    });
  });

  test('reduced motion', () => {
    const settled = stepSprings(makeSprings(MOODS.idle), MOODS.speaking, 1 / 60, true);
    assert({
      given: 'a step that settles',
      should: 'land every spring on its target at rest',
      actual: [settled.core, settled.speed],
      expected: [
        { x: MOODS.speaking.core, v: 0 },
        { x: MOODS.speaking.speed, v: 0 },
      ],
    });
  });

  test('kick()', () => {
    const springs = makeSprings(MOODS.idle);
    assert({
      given: 'a press on the orb',
      should: 'add velocity to that spring alone, leaving the rest',
      actual: [kick(springs, 'squash', -4).squash, kick(springs, 'squash', -4).core === springs.core],
      expected: [{ x: 1, v: -4 }, true],
    });
  });
});

describe('orbBalls()', () => {
  const springs = makeSprings(MOODS.idle);

  test('the orb at rest', () => {
    const balls = orbBalls({ springs, time: 0, phase: 0, gaze: { x: 0, y: 0 }, drops: 2 });
    assert({
      given: 'an idle orb with no gaze and one bulge',
      should: 'centre the orb resting on the page, with the bulge inside its surface',
      actual: [round(balls.slice(0, 4)), Math.hypot(balls[4]!, balls[5]!, balls[6]! - balls[2]!) + balls[7]! < balls[3]! + MOODS.idle.swell * 1.6],
      expected: [[0, 0, 0.54, 0.54], true],
    });
  });

  test('attention', () => {
    const toward = orbBalls({ springs, time: 0, phase: 0, gaze: { x: 1, y: 0 }, drops: 2 });
    const away = orbBalls({ springs, time: 0, phase: 0, gaze: { x: -1, y: 0 }, drops: 2 });
    assert({
      given: 'the pointer to the right, then to the left',
      should: 'swing the first bulge toward it',
      actual: [toward[4]! > 0, away[4]! < 0],
      expected: [true, true],
    });
  });

  test('only the drops asked for', () => {
    const balls = orbBalls({ springs, time: 1, phase: 1, gaze: { x: 0, y: 0 }, drops: 2 });
    assert({
      given: 'a glyph with one bulge',
      should: 'leave the unused slots empty',
      actual: round(balls.slice(8)),
      expected: new Array(16).fill(0),
    });
  });
});

describe('orbBalls() bulges', () => {
  test('never under the orb', () => {
    const springs = makeSprings(MOODS.thinking);
    const lowest = Math.min(
      ...Array.from({ length: 60 }, (_, i) => {
        const balls = orbBalls({ springs, time: i * 0.37, phase: i * 0.91, gaze: { x: 0, y: 0 }, drops: 4 });
        return Math.min(balls[6]! - balls[2]!, balls[10]! - balls[2]!, balls[14]! - balls[2]!) / balls[3]!;
      }),
    );
    assert({
      given: 'a thinking orb sampled over many moments',
      should: 'keep its bulges off the hidden underside, where the page would hide them',
      actual: lowest > -0.4,
      expected: true,
    });
  });
});

// The orb's motion (docs/imago/liquid-metal-engine.md §D5): every mood parameter chases its
// target on an underdamped spring (zeta about 0.58), the overshoot that reads as gel, and the
// bulges travel tilted great circles just inside the surface. Pure: the engine owns time.

import { MOOD_KEYS, type MoodTargets } from './metal-mood';

export type Spring = { readonly x: number; readonly v: number };
export type Springs = Readonly<Record<keyof MoodTargets, Spring>>;

const STIFFNESS = 90;
const DAMPING = 11;

export const makeSprings = (targets: MoodTargets): Springs =>
  Object.fromEntries(MOOD_KEYS.map((key) => [key, { x: targets[key], v: 0 }])) as Springs;

/** One step toward the targets; with `settle` the springs land at once (reduced motion). */
export const stepSprings = (springs: Springs, targets: MoodTargets, dt: number, settle = false): Springs =>
  Object.fromEntries(
    MOOD_KEYS.map((key) => {
      if (settle) return [key, { x: targets[key], v: 0 }];
      const { x, v } = springs[key];
      const nextV = v + (STIFFNESS * (targets[key] - x) - DAMPING * v) * dt;
      return [key, { x: x + nextV * dt, v: nextV }];
    }),
  ) as Springs;

/** Adds velocity to one spring: a press squashes the orb, a token swells it. */
export const kick = (springs: Springs, key: keyof MoodTargets, dv: number): Springs => ({
  ...springs,
  [key]: { x: springs[key].x, v: springs[key].v + dv },
});

/** Where attention points, in view units; up is +y. */
export type Gaze = { readonly x: number; readonly y: number };

/**
 * The field the shader draws: the orb first, then its bulges, as (x, y, z, radius) quadruples.
 * The orb barely moves; it attends to something by swinging its first bulge toward it.
 */
export const orbBalls = ({
  springs,
  time,
  phase,
  gaze,
  drops,
}: {
  readonly springs: Springs;
  readonly time: number;
  /** The bulges' travelled angle, integrated from their speed so a change of speed never jumps. */
  readonly phase: number;
  readonly gaze: Gaze;
  readonly drops: number;
}): Float32Array => {
  const s = (key: keyof MoodTargets) => springs[key].x;
  const balls = new Float32Array(24);
  const core = s('core') * (1 + s('breathe') * Math.sin(time * 1.3));
  const ox = gaze.x * s('lean') * 0.25;
  const oy = gaze.y * s('lean') * 0.25;
  const oz = core * s('squash');
  balls.set([ox, oy, oz, core], 0);
  const gazeMag = Math.min(1, Math.hypot(gaze.x, gaze.y));
  for (let i = 1; i < drops; i++) {
    const a = phase * (1 + i * 0.23) + i * 2.094;
    const tilt = 0.9 + i * 0.7 + 0.3 * Math.sin(time * 0.21 + i);
    let dx = Math.cos(a);
    let dy = Math.sin(a) * Math.cos(tilt);
    let dz = Math.sin(a) * Math.sin(tilt);
    // Keep bulges off the hidden underside.
    if (dz < -0.2) dz = -0.2 - (dz + 0.2) * 0.3;
    if (i === 1 && gazeMag > 0.01) {
      const w = gazeMag * Math.min(1, s('lean') * 7);
      dx = dx * (1 - w) + (gaze.x / gazeMag) * w;
      dy = dy * (1 - w) + (gaze.y / gazeMag) * w;
      dz = dz * (1 - w) + 0.25 * w;
    }
    const len = Math.hypot(dx, dy, dz) || 1;
    const rb = Math.max(0.04, s('bulge') * (1 + 0.15 * Math.sin(time * 1.1 + i * 2)));
    const swell = s('swell') * (1 + 0.5 * Math.sin(time * 0.9 + i * 1.9)) + (i === 1 ? s('lean') * gazeMag * 0.3 : 0);
    const dist = core - rb + swell;
    balls.set([ox + (dx / len) * dist, oy + (dy / len) * dist, oz + (dz / len) * dist, rb], i * 4);
  }
  return balls;
};

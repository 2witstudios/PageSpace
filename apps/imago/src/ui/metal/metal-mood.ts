// Imago's moods (docs/imago/liquid-metal-engine.md §D6): one orb whose surface carries the
// agent's state. Each mood is a set of targets that every parameter chases on a spring, so a
// change of mood reads as the metal settling into a new shape rather than a cut.

import type { StreamingPhase } from '../chat/chat-plugin';

export type MetalMood = 'idle' | 'listening' | 'thinking' | 'speaking';

/** The parameters a mood sets; the shader and the orb layout read them. */
export type MoodTargets = {
  /** The orb's radius, in view units (the view spans -1..1). */
  readonly core: number;
  /** Each bulge's radius. */
  readonly bulge: number;
  /** How far a bulge pushes past the surface. */
  readonly swell: number;
  /** How fast the bulges travel under the surface. */
  readonly speed: number;
  /** How softly the bulges blend into the orb (smooth-min k). */
  readonly k: number;
  /** How deep the folds run. */
  readonly churn: number;
  /** The low-order wobble of the surface. */
  readonly wobble: number;
  /** How far the attention bulge reaches toward the pointer or the composer. */
  readonly lean: number;
  /** Height over width: above 1 stands tall, below 1 sags. */
  readonly squash: number;
  /** The breathing amplitude. */
  readonly breathe: number;
};

export const MOODS: Readonly<Record<MetalMood, MoodTargets>> = {
  idle: { core: 0.54, bulge: 0.22, swell: 0.045, speed: 0.22, k: 0.24, churn: 0.02, wobble: 0.02, lean: 0.05, squash: 1, breathe: 0.022 },
  listening: { core: 0.55, bulge: 0.24, swell: 0.025, speed: 0.1, k: 0.26, churn: 0.01, wobble: 0.01, lean: 0.12, squash: 1.03, breathe: 0.012 },
  thinking: { core: 0.52, bulge: 0.22, swell: 0.06, speed: 1.2, k: 0.26, churn: 0.07, wobble: 0.036, lean: 0.02, squash: 0.97, breathe: 0.03 },
  speaking: { core: 0.54, bulge: 0.2, swell: 0.05, speed: 0.45, k: 0.24, churn: 0.04, wobble: 0.022, lean: 0.06, squash: 1, breathe: 0.02 },
};

export const MOOD_KEYS = Object.keys(MOODS.idle) as readonly (keyof MoodTargets)[];

/**
 * Imago's mood from state the shell already has: a turn under way wins (thinking, then
 * speaking); otherwise a focused composer means it is listening.
 */
export const moodFor = ({
  phase,
  composerFocused,
}: {
  readonly phase: StreamingPhase | null;
  readonly composerFocused: boolean;
}): MetalMood => (phase !== null ? phase : composerFocused ? 'listening' : 'idle');

/** What an orb this size can carry: a glyph has no room for choreography, only mood. */
export type OrbDetail = {
  /** Spheres in the field: the orb plus its bulges. */
  readonly drops: number;
  readonly churnScale: number;
  readonly wobbleScale: number;
  readonly pulses: boolean;
};

export const detailFor = (cssPixels: number): OrbDetail =>
  cssPixels >= 80
    ? { drops: 4, churnScale: 1, wobbleScale: 1, pulses: true }
    : cssPixels >= 24
      ? { drops: 3, churnScale: 0.5, wobbleScale: 1, pulses: true }
      : { drops: 2, churnScale: 0, wobbleScale: 0.5, pulses: false };

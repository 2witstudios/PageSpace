/**
 * A RATCHET ON THE DUPLICATION BETWEEN THE TWO TURN STRATEGIES.
 *
 * `handle-chat-turn.ts`'s docblock argues — correctly — that
 * `runPageChatTurn` and `runGlobalChatTurn` should not collapse into one
 * function with twenty conditionals, several of them security decisions. What
 * that argument does NOT license is the two drifting into copies of each
 * other, and they already have: `5c1bc5410` on this branch is titled "bring
 * the global assistant to parity with the page chat".
 *
 * Two reviews measured the overlap independently and the epic's docs now state
 * the figure. A stated figure with nothing enforcing it is exactly the failure
 * mode §5 of `docs/2.0-architecture/agent-sessions.md` names — a description
 * the code no longer enforces is worse than no description — so this test does
 * two things:
 *
 *   1. RATCHET. New copy-paste between the two files fails here. Not a
 *      prohibition on duplication, a prohibition on MORE of it: the current
 *      figure is the ceiling, and it may only be lowered.
 *   2. DRIFT GUARD. The number written in the two prose homes must equal the
 *      number this test measures, so nobody can reduce the duplication and
 *      leave the docs overstating it, or add some and leave them understating
 *      it.
 *
 * Deliberately a LINE-SET measure rather than a clone detector: it needs no
 * dependency, it is trivially reproducible by hand (`strip comments and
 * blanks, intersect, keep the long ones`), and its failure message can say
 * exactly what to do. It undercounts real duplication — reordered or slightly
 * edited copies do not register — which is the right direction for a ratchet.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const DIR = path.resolve(__dirname, '..');
const PAGE = path.join(DIR, 'page-chat-turn.ts');
const GLOBAL = path.join(DIR, 'global-chat-turn.ts');
const ENTRY = path.join(DIR, 'handle-chat-turn.ts');
/**
 * The repo root, found by walking up to the directory that holds `docs/`,
 * rather than counting seven `..` segments — that count is invisible to a
 * reader and silently wrong the moment this file moves. Throws with a usable
 * message if the walk fails, instead of an ENOENT from inside an assertion.
 */
const repoRoot = (): string => {
  let dir = __dirname;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, 'docs', '2.0-architecture'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'turn-duplication-ratchet: could not locate the repo root from ' +
      `${__dirname}. If the docs moved, update this test's SPEC path.`,
  );
};
const SPEC = path.join(repoRoot(), 'docs/2.0-architecture/agent-sessions.md');

/**
 * The recorded ceiling. LOWER THIS when you remove duplication — the drift
 * guard below will tell you to, because the prose has to move with it.
 *
 * The epilogue (stream construction, `onFinish`, terminal persist, hold
 * settle, telemetry) is where most of it lives and is the extraction that
 * would pay first; see the entry's docblock.
 */
const RECORDED_IDENTICAL_LINES = 161;

/** Substantive lines: no blanks, no comments, trimmed. */
const substantiveLines = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(\/\/|\/\*|\*)/.test(line));

/**
 * Identical lines of 40+ characters. The length floor keeps the measure
 * meaningful: `});`, `}` and `try {` are identical in every TypeScript file
 * ever written and say nothing about duplicated logic.
 */
const identicalSubstantiveLines = (): string[] => {
  const page = new Set(substantiveLines(PAGE));
  const global = new Set(substantiveLines(GLOBAL));
  return [...page].filter((line) => global.has(line) && line.length >= 40).sort();
};

describe('page/global turn duplication', () => {
  it(`does not exceed the recorded ${RECORDED_IDENTICAL_LINES} identical substantive lines`, () => {
    const identical = identicalSubstantiveLines();

    expect(
      identical.length,
      `The two turn strategies now share ${identical.length} identical substantive lines, up from ` +
        `${RECORDED_IDENTICAL_LINES}. Something was copied between page-chat-turn.ts and ` +
        `global-chat-turn.ts rather than shared. Extract it (start-chat-generation.ts is the ` +
        `precedent) — or, if the duplication is genuinely justified, raise the ceiling in this ` +
        `file AND in the two prose homes the drift guard below checks.`,
    ).toBeLessThanOrEqual(RECORDED_IDENTICAL_LINES);
  });

  it('is described accurately by the entry docblock and the epic spec', () => {
    const identical = identicalSubstantiveLines();
    // Exact, not `<=`, and the direction that surprises people is DOWN: if you
    // just removed duplication, this fails on purpose. Lower
    // RECORDED_IDENTICAL_LINES and the two prose figures together — that is
    // the whole mechanism keeping the docs from overstating a gap someone
    // already closed.
    expect(
      identical.length,
      `The measurement is ${identical.length} but this file records ` +
        `${RECORDED_IDENTICAL_LINES}. If you REDUCED the duplication: lower ` +
        `RECORDED_IDENTICAL_LINES here, and update the figure in ` +
        `handle-chat-turn.ts and docs/2.0-architecture/agent-sessions.md to ` +
        `match. If you added some, the ratchet above already told you.`,
    ).toBe(RECORDED_IDENTICAL_LINES);

    for (const [label, file] of [
      ['handle-chat-turn.ts', ENTRY],
      ['docs/2.0-architecture/agent-sessions.md', SPEC],
    ] as const) {
      expect(
        readFileSync(file, 'utf8'),
        `${label} states a duplication figure that no longer matches the measurement ` +
          `(${identical.length}). Update the prose, or you have left this epic's own docs ` +
          `saying something the code does not.`,
      ).toContain(`${RECORDED_IDENTICAL_LINES} substantive lines`);
    }
  });

  it('still concentrates in the epilogue — the region the extraction plan names', () => {
    // Not a count but a shape: if the shared lines stopped being the
    // stream/settle/telemetry tail, the recorded extraction target would be
    // pointing at the wrong place, and the plan would quietly be wrong rather
    // than merely unfinished.
    const identical = identicalSubstantiveLines();
    const epilogueMarkers = identical.filter((line) =>
      /onFinish|releaseHold|settle|streamText|createUIMessageStream|activeStreamId/i.test(line),
    );

    expect(epilogueMarkers.length).toBeGreaterThan(0);
  });
});

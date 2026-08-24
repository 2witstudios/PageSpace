/**
 * Merge guard over every multi-step model loop. This is a source-scan invariant:
 * it reads the call sites and fails the build if a new agent loop forgets the
 * per-step tool-payload cap.
 *
 * #2461 was not one broken loop, it was a missing seam. History is prepared once
 * per turn, so any loop that takes many model calls accumulates its own oversized
 * tool payloads for the whole run and eventually exhausts the context window.
 * Six call sites need `capStepToolPayloads`, they live in four directories, and a
 * seventh added later would reintroduce the bug silently — the review that caught
 * two of the six is exactly the kind of thing that should not have to be noticed
 * twice. See cap-step-tool-payloads.ts.
 *
 * A loop is only in scope when it passes `tools`: without them the model cannot
 * emit tool calls, so there is nothing to accumulate and nothing to cap.
 *
 * Scoped to src/. The one loop outside it (scripts/redteam-sandbox-injection.ts)
 * is a hand-run security probe with stubbed, non-executing tools and a two-step
 * budget — nothing accumulates across two steps.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// vitest runs with cwd = apps/web.
const SRC_DIR = join(process.cwd(), 'src');

const srcRelPath = (file: string) => relative(SRC_DIR, file).split(sep).join('/');

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests build their own deliberately-uncapped loops as fixtures.
      if (entry.name === '__tests__') continue;
      out.push(...allSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The argument object of each `streamText({` / `generateText({` call, matched by
 * brace balance so a call spanning two hundred lines is still read whole.
 *
 * Comments are STRIPPED from what is returned, not merely stepped over. A
 * mutation check caught why that matters: deleting the wiring from a chat turn
 * left the comment above it ("see agentLoopPrepareStep") in the slice, and the
 * guard below happily matched the prose and passed. A guard a comment can
 * satisfy is not a guard. String literals are stepped over too, so a `}` inside
 * a prompt cannot end the slice early and hide the rest of the call.
 */
function modelCallSlices(src: string): string[] {
  const slices: string[] = [];
  const callPattern = /\b(?:streamText|generateText)\s*\(\s*\{/g;
  let match = callPattern.exec(src);

  while (match !== null) {
    const open = src.indexOf('{', match.index);
    let depth = 0;
    let i = open;
    let code = '';

    while (i < src.length) {
      const ch = src[i];
      const next = src[i + 1];

      if (ch === '/' && next === '/') {
        const eol = src.indexOf('\n', i);
        if (eol === -1) break;
        i = eol;
      } else if (ch === '/' && next === '*') {
        const close = src.indexOf('*/', i + 2);
        if (close === -1) break;
        i = close + 1;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        code += ch;
        i += 1;
        while (i < src.length && src[i] !== quote) {
          code += src[i];
          if (src[i] === '\\') {
            i += 1;
            code += src[i];
          }
          i += 1;
        }
        code += quote;
      } else if (ch === '{') {
        depth += 1;
        code += ch;
      } else if (ch === '}') {
        depth -= 1;
        code += ch;
        if (depth === 0) {
          slices.push(code);
          break;
        }
      } else {
        code += ch;
      }
      i += 1;
    }

    match = callPattern.exec(src);
  }

  return slices;
}

/** A loop takes many model calls when it declares a step budget. */
const isMultiStep = (slice: string) => slice.includes('stopWhen');
/** Only a loop that can emit tool calls has payloads to cap. */
const passesTools = (slice: string) => /\btools\s*:/.test(slice);

/**
 * Either form counts. The two chat turns also re-mark cache breakpoints per
 * step, so they share `agentLoopPrepareStep`, which composes the cap with
 * `withCacheBreakpoints` — keeping the wiring out of turn-duplication-ratchet's
 * way. Loops with no boundary to re-mark call the cap directly.
 */
const capsItsPayloads = (slice: string) =>
  /\b(?:capStepToolPayloads|agentLoopPrepareStep)\s*\(/.test(slice);

const SOURCE_FILES = allSourceFiles(SRC_DIR);

describe('per-step tool-payload cap call-site guard', () => {
  it('found the source files (the guard is actually scanning something)', () => {
    expect(SOURCE_FILES.length, 'the scan found no source files — SRC_DIR is wrong').toBeGreaterThan(0);
    expect(
      SOURCE_FILES.some((f) => srcRelPath(f) === 'lib/ai/chat-pipeline/global-chat-turn.ts'),
      'global-chat-turn.ts is not in the scanned set, so this guard is checking nothing',
    ).toBe(true);
  });

  it('sees every multi-step tool loop the codebase has', () => {
    const found: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const slice of modelCallSlices(readFileSync(file, 'utf8'))) {
        if (isMultiStep(slice) && passesTools(slice)) found.push(srcRelPath(file));
      }
    }

    // Pinned so the guard cannot quietly stop matching. The guidance lives in the
    // assertion message, not just here, because a comment is not what a failing
    // developer sees.
    expect(
      found.sort(),
      'The set of multi-step tool loops changed. If a NEW loop was added: wire ' +
        '`capStepToolPayloads` into its `prepareStep` (or `agentLoopPrepareStep` if it also ' +
        'marks cache breakpoints) and add the file to this list — an uncapped loop ' +
        'reintroduces #2461, where one turn\'s own tool payloads exhaust the context window ' +
        'and the provider starts emitting argument-less tool calls. If a loop was REMOVED, ' +
        'drop it from the list. If the list is unchanged but this still fails, the brace ' +
        'slicer stopped matching — fix the slicer rather than the list, or the guard goes ' +
        'quietly blind.',
    ).toEqual([
      'app/api/ai/page-agents/consult/route.ts',
      'app/api/v1/chat/completions/route.ts',
      'lib/ai/chat-pipeline/global-chat-turn.ts',
      'lib/ai/chat-pipeline/page-chat-turn.ts',
      'lib/ai/tools/agent-communication-tools.ts',
      'lib/workflows/workflow-executor.ts',
    ]);
  });

  it('every multi-step tool loop caps its per-step tool payloads', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const slice of modelCallSlices(readFileSync(file, 'utf8'))) {
        if (!isMultiStep(slice) || !passesTools(slice)) continue;
        if (!capsItsPayloads(slice)) offenders.push(srcRelPath(file));
      }
    }
    expect(
      offenders,
      'These multi-step tool loops do not cap their per-step tool payloads. History is ' +
        'prepared once per TURN, but a turn is up to AGENT_MAX_STEPS model calls, so an ' +
        'uncapped loop accumulates its own oversized arguments AND results for its whole ' +
        'run until the context window is gone (#2461). Add `prepareStep: ({ messages }) => ' +
        '({ messages: capStepToolPayloads(messages) })`, or `agentLoopPrepareStep(' +
        'stableBoundaryIndex)` if the loop also marks cache breakpoints.',
    ).toEqual([]);
  });
});

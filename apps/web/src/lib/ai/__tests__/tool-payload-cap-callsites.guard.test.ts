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
 * String literals and comments are skipped — a `}` inside a prompt string would
 * otherwise end the slice early and hide the rest of the call from the guard.
 */
function modelCallSlices(src: string): string[] {
  const slices: string[] = [];
  const callPattern = /\b(?:streamText|generateText)\s*\(\s*\{/g;
  let match = callPattern.exec(src);

  while (match !== null) {
    const open = src.indexOf('{', match.index);
    let depth = 0;
    let i = open;

    while (i < src.length) {
      const ch = src[i];
      const next = src[i + 1];

      if (ch === '/' && next === '/') {
        i = src.indexOf('\n', i);
        if (i === -1) break;
      } else if (ch === '/' && next === '*') {
        const close = src.indexOf('*/', i + 2);
        if (close === -1) break;
        i = close + 1;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        i += 1;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i += 1;
          i += 1;
        }
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          slices.push(src.slice(open, i + 1));
          break;
        }
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

const SOURCE_FILES = allSourceFiles(SRC_DIR);

describe('per-step tool-payload cap call-site guard', () => {
  it('found the source files (the guard is actually scanning something)', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
    expect(
      SOURCE_FILES.some((f) => srcRelPath(f) === 'lib/ai/chat-pipeline/global-chat-turn.ts')
    ).toBe(true);
  });

  it('sees every multi-step tool loop the codebase has', () => {
    const found: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const slice of modelCallSlices(readFileSync(file, 'utf8'))) {
        if (isMultiStep(slice) && passesTools(slice)) found.push(srcRelPath(file));
      }
    }

    // Pinned so the guard cannot quietly stop matching. If this fails because a
    // NEW loop was added, add the file here and cap it; if it fails because the
    // slicer broke, fix the slicer — do not just update the list.
    expect(found.sort()).toEqual([
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
        if (!slice.includes('capStepToolPayloads')) offenders.push(srcRelPath(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

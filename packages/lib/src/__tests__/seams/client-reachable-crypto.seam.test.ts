/**
 * A client hook (apps/web useAiUsage) imports @pagespace/lib/monitoring/ai-monitoring, and the web
 * bundler follows its STATIC imports into the browser. Field encryption runs promisify(scrypt) at
 * module load, which throws in a browser bundle and blanks every page that reaches it (#2763: every
 * chat, dispatch and pane E2E timed out). Nothing in ai-monitoring's static import graph may load
 * the encryption modules; server-only users load them on call (await import()).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
// A value import or re-export: `import type` / `export type` and dynamic import() are not followed.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@pagespace/lib/')) base = join(SRC, spec.slice('@pagespace/lib/'.length));
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  else return null;
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(candidate)) return candidate;
  return null;
}

function staticClosure(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const next = resolve(file, match[1]);
      if (next && !seen.has(next)) {
        seen.set(next, file);
        stack.push(next);
      }
    }
  }
  return seen;
}

describe('client-reachable lib modules load no field encryption', () => {
  it('monitoring/ai-monitoring (imported by a client hook) never statically reaches the encryption modules', () => {
    const closure = staticClosure(join(SRC, 'monitoring/ai-monitoring.ts'));
    const offenders = [...closure.keys()].filter((f) => f.includes(`${'/encryption/'}`));
    const chains = offenders.map((f) => {
      const chain = [f];
      let parent = closure.get(f) ?? null;
      while (parent) { chain.push(parent); parent = closure.get(parent) ?? null; }
      return chain.map((c) => c.slice(SRC.length + 1)).join(' <- ');
    });
    expect(chains).toEqual([]);
  });
});

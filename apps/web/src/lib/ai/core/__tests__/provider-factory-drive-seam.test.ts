/**
 * Seam guard: every place that builds an AI provider decides which drive governs it (Spec POL-8).
 *
 * The org's model and provider allowlists are enforced inside createAIProvider for the drive the caller names, and
 * `driveId` is a REQUIRED option, so the compiler refuses a caller that forgets it. What the compiler cannot see is a
 * caller that says `driveId: null` (no drive, no org) when it does run in a drive. So every literal `driveId: null`
 * must be listed here with the reason the call runs in no drive. A new one is neither until someone decides.
 *
 * Limits, stated: this is a source scan. It proves each call names a drive, not that the value is the right drive
 * (the per-caller tests prove that), and it does not see a provider built by some path other than createAIProvider
 * (there is none: the factory is the only constructor of a provider).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../..');

/**
 * Files whose createAIProvider call runs in no drive, each with why. These calls spend personal credits (SPEND-8);
 * the ones that READ org content (memory discovery, pulse) keep out the drives whose org does not allow their model
 * (scopeReadableByModel), so no org's content reaches a model it does not allow.
 */
const NO_DRIVE: Record<string, string> = {
  'lib/memory/compaction-service.ts': "a person's own memory compaction: it condenses their personal memory text, no drive",
  'lib/memory/integration-service.ts': "a person's own memory integration: it edits their personal memory pages, no drive",
  'lib/memory/discovery-service.ts': "a person's own memory discovery: no drive; it reads only drives whose org allows the model",
  'app/api/pulse/generate/route.ts': "the person's own pulse digest: no drive; it reads only drives whose org allows the model",
  'app/api/pulse/cron/route.ts': "the person's own pulse digest: no drive; it reads only drives whose org allows the model",
};

const NAMES_NO_DRIVE = /\bdriveId\s*:\s*null\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

/** The text of each `createAIProvider(...)` call, through its matching parenthesis. */
export function createAIProviderCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /\bcreateAIProvider\s*\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < source.length) {
      const c = source[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    calls.push(source.slice(m.index, i));
  }
  return calls;
}

describe('the provider factory is always told the drive', () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith('provider-factory.ts'));
  const callers = files.flatMap((f) => createAIProviderCalls(readFileSync(f, 'utf8')).map((call) => ({ file: relative(SRC, f), call })));

  it('POL-8 (partial) finds the known callers (the scan is not vacuous)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(12);
  });

  it('POL-8 (partial) every call names a driveId', () => {
    expect(callers.filter(({ call }) => !/\bdriveId\b/.test(call)).map((c) => c.file)).toEqual([]);
  });

  it('POL-8 (partial) every call that says it runs in no drive (driveId: null) is listed with the reason', () => {
    expect(callers.filter(({ file, call }) => NAMES_NO_DRIVE.test(call) && !(file in NO_DRIVE)).map((c) => c.file)).toEqual([]);
  });

  it('POL-8 (partial) a listed file really runs in no drive (a stale exemption fails)', () => {
    const stale = callers.filter(({ file, call }) => file in NO_DRIVE && !NAMES_NO_DRIVE.test(call)).map((c) => c.file);
    expect(stale).toEqual([]);
  });

  it('POL-8 (partial) every listed file still exists and still calls the factory', () => {
    const present = new Set(callers.map((c) => c.file));
    expect(Object.keys(NO_DRIVE).filter((f) => !present.has(f))).toEqual([]);
  });

  it('POL-8 (partial) the detector sees a call whose options span lines and ignores one in a comment-free helper', () => {
    const calls = createAIProviderCalls("const a = await createAIProvider(u, {\n  selectedModel: m,\n}, { driveId: d });\nconst b = createAIProvider(u, {});");
    expect(calls).toHaveLength(2);
    expect(/\bdriveId\b/.test(calls[0])).toBe(true);
    expect(/\bdriveId\b/.test(calls[1])).toBe(false);
  });
});

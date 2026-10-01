/**
 * Seam guard: every place that builds an AI provider decides which drive it runs in (Spec POL-8).
 *
 * The org's model and provider allowlists are enforced inside createAIProvider, but only when the caller names the
 * drive. A caller that simply forgets would run any model in an org drive and nothing would say so. So every
 * production call must pass `driveId` in its options, or be listed here with the reason it has no drive. A new caller
 * is neither until someone decides, which is the point.
 *
 * Limits, stated: this is a source scan. It proves each call names a drive option, not that the value is the right
 * drive (the per-caller tests prove that for the callers with an org drive), and it does not see a provider built by
 * some path other than createAIProvider (there is none: the factory is the only constructor of a provider).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../..');

/** Files whose createAIProvider call has no drive, each with why. */
const NO_DRIVE: Record<string, string> = {
  'lib/memory/compaction-service.ts': "a person's own memory compaction: no drive, no org",
  'lib/memory/integration-service.ts': "a person's own memory integration: no drive, no org",
  'lib/memory/discovery-service.ts': "a person's own memory discovery: no drive, no org",
  'lib/ai/core/compaction/compaction-service.ts': 'conversation compaction runs for the person; it carries no drive and spends no drive wallet',
  'lib/integrations/zoom/generate-summary.ts': "a person's own Zoom meeting summary: no drive",
  'lib/integrations/zoom/extract-action-items.ts': "a person's own Zoom action items: no drive",
  'app/api/pulse/generate/route.ts': "the person's own pulse digest: personal credits, no drive",
  'app/api/pulse/cron/route.ts': "the person's own pulse digest: personal credits, no drive",
};

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

  it('POL-8 (partial) every call names a driveId, or its file is listed with the reason it has no drive', () => {
    const offenders = callers.filter(({ file, call }) => !/\bdriveId\b/.test(call) && !(file in NO_DRIVE)).map((c) => c.file);
    expect(offenders).toEqual([]);
  });

  it('POL-8 (partial) an allowlisted file really has no driveId (a stale exemption fails)', () => {
    const stale = callers.filter(({ file, call }) => file in NO_DRIVE && /\bdriveId\b/.test(call)).map((c) => c.file);
    expect(stale).toEqual([]);
  });

  it('POL-8 (partial) every allowlisted file still exists and still calls the factory', () => {
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

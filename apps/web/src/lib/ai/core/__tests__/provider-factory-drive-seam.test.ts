/**
 * Seam guard: every place that builds an AI provider decides which drive governs it (Spec POL-8).
 *
 * The org's model and provider allowlists are enforced inside the provider factory (createAIProvider, and
 * createImageProvider for image models) for the drive the caller names, and `driveId` is a REQUIRED option, so the
 * compiler refuses a caller that forgets it. What the compiler cannot see is a caller whose drive may be NO drive:
 * a literal `null`, a ternary or `??` that can end in null, a helper that answers null for personal spend, or a bare
 * variable. So every call's `driveId` must be a drive read off a row or input (`x.driveId`), or its file is listed
 * here with the reason it may run in no drive. A new one is neither until someone decides.
 *
 * And the factory is the ONLY constructor of a provider: no other module calls a provider SDK's constructor.
 *
 * Limits, stated: this is a source scan. It proves each call names a drive or explains why it may not, not that the
 * value is the right drive (the per-caller tests prove that).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../..');

/**
 * Files whose provider call may run in no drive, each with why. A call in no drive spends personal credits (SPEND-8)
 * and no org governs the call itself; whatever ORG content it reads is still kept from a model the org does not
 * allow: memory discovery and pulse read only drives whose org allows their model (scopeReadableByModel), and a
 * chat's tools cannot read a page or drive of such an org (actor-permissions, the tool boundary).
 */
const MAY_BE_NO_DRIVE: Record<string, string> = {
  'lib/memory/compaction-service.ts': "a person's own memory compaction: it condenses their personal memory text, no drive",
  'lib/memory/integration-service.ts': "a person's own memory integration: it edits their personal memory pages, no drive",
  'lib/memory/discovery-service.ts': "a person's own memory discovery: no drive; it reads only conversations and drives whose org allows the model",
  'app/api/pulse/generate/route.ts': "the person's own pulse digest: no drive; it reads only drives whose org allows the model",
  'app/api/pulse/cron/route.ts': "the person's own pulse digest: no drive; it reads only drives whose org allows the model",
  'lib/ai/chat-pipeline/global-chat-turn.ts': 'the global assistant: the server-resolved contextRef drive, or none without one; its tools cannot read org content the model is not allowed',
  'app/api/ai/btw/route.ts': "a side question runs in its conversation's session drive (SPEND-7), none for a global conversation",
  'app/api/v1/chat/completions/route.ts': "the session the completion runs in (its spend drive, else the agent page's drive: never null), and the agent page's drive is always named as a content drive (D-OW-64)",
  'lib/ai/core/compaction/compaction-service.ts': "conversation compaction runs in its turn's spend drive (spendDriveId), none for personal spend",
  'lib/ai/tools/agent-communication-tools.ts': "ask_agent: the caller's spend drive (none for personal spend), and the consulted agent's drive is always named as a content drive",
  'lib/ai/tools/image-generation-tools.ts': "the turn's spend drive (none for personal spend), and the destination drive is named as a content drive",
};

/** A drive read off a row or input: `page.driveId`, `input.driveId`, `billing.driveId` (no optional chaining). */
const NAMES_A_DRIVE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\.driveId$/;

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

/** The text of each `createAIProvider(...)` / `createImageProvider(...)` call, through its matching parenthesis. */
export function providerCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /\bcreate(?:AI|Image)Provider\s*\(/g;
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

/** The expression a call passes as `driveId` (`{ driveId }` shorthand included), or null when it names none. */
export function driveIdExpression(call: string): string | null {
  // The option KEY, never a `.driveId` read inside its value.
  const m = /(?<![.\w$])driveId\b\s*(:)?/g;
  let last: RegExpExecArray | null = null;
  for (let hit = m.exec(call); hit; hit = m.exec(call)) last = hit;
  if (!last) return null;
  if (!last[1]) return 'driveId';
  let depth = 0;
  let i = last.index + last[0].length;
  const start = i;
  for (; i < call.length; i += 1) {
    const c = call[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) break;
  }
  return call.slice(start, i).trim();
}

describe('the provider factory is always told the drive', () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith('provider-factory.ts'));
  const callers = files.flatMap((f) => providerCalls(readFileSync(f, 'utf8')).map((call) => ({ file: relative(SRC, f), call, drive: driveIdExpression(call) })));

  it('POL-8 (partial) finds the known callers (the scan is not vacuous)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(14);
  });

  it('POL-8 (partial) every call names a driveId', () => {
    expect(callers.filter(({ drive }) => drive === null).map((c) => c.file)).toEqual([]);
  });

  it('POL-8 (partial) every call whose drive may be NO drive (null literal, ternary, ??, helper call, bare variable) is listed with the reason', () => {
    const unexplained = callers.filter(({ file, drive }) => drive !== null && !NAMES_A_DRIVE.test(drive) && !(file in MAY_BE_NO_DRIVE));
    expect(unexplained.map((c) => `${c.file}: driveId ${c.drive}`)).toEqual([]);
  });

  it('POL-8 (partial) a listed file really has a call that may run in no drive (a stale exemption fails)', () => {
    const mayBeNone = new Set(callers.filter(({ drive }) => drive !== null && !NAMES_A_DRIVE.test(drive)).map((c) => c.file));
    expect(Object.keys(MAY_BE_NO_DRIVE).filter((f) => !mayBeNone.has(f))).toEqual([]);
  });

  it('POL-8 (partial) the classifier: a row\'s drive names a drive; null, a ternary, ??, a helper call or a bare variable may not', () => {
    const expr = (opts: string) => driveIdExpression(`createAIProvider(u, {}, ${opts})`);
    expect(expr('{ driveId: page.driveId }')).toBe('page.driveId');
    expect(NAMES_A_DRIVE.test(expr('{ user, driveId: input.driveId }')!)).toBe(true);
    for (const opts of ['{ driveId: null }', '{ driveId: a ? b.driveId : null }', '{ driveId: x?.driveId ?? null }', '{ driveId: spendDriveId(spend), contentDriveIds: [a] }', '{ driveId }', '{ driveId: sessionDriveId }']) {
      const e = expr(opts);
      expect(e, opts).not.toBeNull();
      expect(NAMES_A_DRIVE.test(e!), opts).toBe(false);
    }
    expect(expr('{ user }')).toBeNull();
    expect(providerCalls("const a = await createAIProvider(u, {\n  selectedModel: m,\n}, { driveId: d.driveId });\nconst b = createImageProvider({ model }, { driveId: null });")).toHaveLength(2);
  });

  it('POL-8 (partial) the factory is the only constructor of a provider: no other module calls a provider SDK constructor', () => {
    const constructors = /\b(createOpenRouter|createOpenAICompatible|createOllama|createOpenAI|createAnthropic|createGoogleGenerativeAI|createXai)\s*\(/;
    expect(files.filter((f) => constructors.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f))).toEqual([]);
  });
});

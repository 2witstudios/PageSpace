/**
 * Guards that starter skill bodies only name tools that actually exist.
 *
 * A skill body is instructions the model follows literally, so a stale tool name
 * is worse than a typo: the agent confidently calls something that isn't there
 * and has to recover mid-task. Nothing else catches this — the bodies live in
 * packages/lib, which cannot import the apps/web tool registry, so the
 * cross-check has to happen here.
 *
 * This is the guard that will fire when a tool is renamed, which is exactly when
 * a body silently goes wrong.
 */
import { describe, it, expect } from 'vitest';
import { STARTER_SKILLS } from '@pagespace/lib/commands/starter-skills';
import { WORKSPACE_TOOL_NAMES } from '@/lib/ai/core/ai-tools';

/**
 * Backticked lowercase_snake identifiers in a body. Tool names are always
 * written in backticks in these bodies (house style), so this is where a stale
 * name would hide.
 *
 * Deliberately lowercase-only: every PageSpace tool is snake_case, so this
 * matches the whole tool namespace while ignoring the camelCase parameter and
 * response-field names bodies also backtick (`pageId`, `lineStart`,
 * `contentClipped`). Those need no allowlist because the pattern never sees
 * them — a camelCase tool name would slip through, but none exists and adding
 * one would break the repo's own naming convention first.
 */
function backtickedIdentifiers(body: string): string[] {
  return [...new Set(body.match(/`[a-z][a-z0-9_]*`/g) ?? [])].map((m) => m.slice(1, -1));
}

/**
 * Lowercase identifiers that look like tool names but deliberately are not.
 *
 * `search` is the load-bearing entry: the body references it ONLY to tell the
 * agent it does not exist, because models reach for a generic search tool by
 * habit. The rest are snake_case parameter names a body may legitimately
 * backtick.
 */
const NOT_TOOLS = new Set(['search', 'content', 'recursive', 'tool_name']);

const KNOWN_TOOLS = new Set([...WORKSPACE_TOOL_NAMES, 'load_skill']);

describe('starter skill bodies reference only real tools', () => {
  it.each(STARTER_SKILLS.map((s) => [s.trigger, s.body] as const))(
    '%s names no tool that does not exist',
    (_trigger, body) => {
      const unknown = backtickedIdentifiers(body).filter(
        (id) => !KNOWN_TOOLS.has(id) && !NOT_TOOLS.has(id),
      );
      expect(unknown, `unrecognised identifiers in body: ${unknown.join(', ')}`).toEqual([]);
    },
  );

  it('the plan body still steers the agent away from the non-existent `search`', () => {
    // Deliberate: models reach for a generic `search` tool. If this line is ever
    // dropped, the body loses the correction that stops that.
    const plan = STARTER_SKILLS.find((s) => s.trigger === 'plan')!;
    expect(plan.body).toMatch(/no tool called .?search/i);
    for (const real of ['regex_search', 'glob_search', 'multi_drive_search']) {
      expect(plan.body).toContain(real);
    }
  });

  it('the plan body does not promise a full subtree without naming `recursive`', () => {
    // list_pages returns DIRECT CHILDREN by default. An earlier draft claimed it
    // pulled "a whole subtree in ONE call", which would have had the agent plan
    // against a silently partial picture.
    const plan = STARTER_SKILLS.find((s) => s.trigger === 'plan')!;
    if (/subtree/i.test(plan.body)) {
      expect(plan.body).toContain('recursive');
    }
  });
});

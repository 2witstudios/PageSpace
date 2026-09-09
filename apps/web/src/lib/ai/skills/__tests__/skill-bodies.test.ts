import { describe, it, expect } from 'vitest';
import {
  BUILTIN_SKILLS,
  validateCommandDescription,
  validateCommandTrigger,
} from '@pagespace/lib/commands/command-core';
import { getSkillBody } from '../skill-bodies';
import { WORKSPACE_TOOL_NAMES } from '@/lib/ai/core/ai-tools';

/**
 * Size guards follow the Agent Skills authoring guidance: a body is a
 * focused instruction pack (< 500 lines / ~5k tokens), not a reference dump.
 * Level-3 detail belongs in child resources, not the body.
 */
const MAX_BODY_CHARS = 20_000;
const MAX_BODY_LINES = 500;

describe('skill bodies', () => {
  it('every registered builtin skill has a body (registry ↔ body parity)', () => {
    for (const skill of BUILTIN_SKILLS) {
      const body = getSkillBody(skill.trigger);
      expect(body, `missing body for ${skill.trigger}`).toBeTruthy();
    }
  });

  it('every requiredTools entry names a tool that exists', () => {
    // `requiredTools` gates skill DISCOVERY (see skill-tools.test.ts): a skill
    // is offered to an agent that holds those tools. A stale or misspelled name
    // therefore fails silently and in the worst direction — the skill simply
    // stops being surfaced, with nothing to notice. Nothing else checks this:
    // the registry lives in packages/lib, which cannot import the apps/web tool
    // registry, so the cross-check has to happen here (same reason as
    // starter-skill-tool-references.test.ts).
    const known = new Set(WORKSPACE_TOOL_NAMES);
    const stale = BUILTIN_SKILLS.flatMap((skill) =>
      (skill.requiredTools ?? [])
        .filter((tool) => !known.has(tool))
        .map((tool) => `${skill.trigger} -> ${tool}`),
    );

    expect(stale, `requiredTools naming tools that do not exist: ${stale.join(', ')}`).toEqual([]);
  });

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))('%s body names only tools that exist', (trigger) => {
    // A body that names a tool the registry lacks sends the model into an
    // unknown-tool call. Backticked snake_case is how every body spells a
    // tool name; the task-management body also backticks task STATUS and
    // FIELD names in the same style, listed here so they are not mistaken
    // for tools (same device as starter-skill-tool-references.test.ts).
    const NOT_TOOLS = new Set(['in_progress', 'in_review', 'due_date']);
    const known = new Set(WORKSPACE_TOOL_NAMES);
    const mentioned = [...new Set([...getSkillBody(trigger)!.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];
    const unknown = mentioned.filter((name) => !known.has(name) && !NOT_TOOLS.has(name));
    expect(unknown, `${trigger} names tools that do not exist: ${unknown.join(', ')}`).toEqual([]);
  });

  it('the spreadsheets body extractor is live: it sees all four sheet tools', () => {
    const mentioned = new Set([...getSkillBody('spreadsheets')!.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
    for (const name of ['read_sheet', 'edit_sheet_cells', 'format_sheet', 'set_conditional_format']) {
      expect(mentioned.has(name), name).toBe(true);
    }
  });

  it('unknown triggers return null', () => {
    expect(getSkillBody('nonexistent-skill')).toBeNull();
    expect(getSkillBody('help')).toBeNull();
  });

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))('%s body respects size guards', (trigger) => {
    const body = getSkillBody(trigger)!;
    expect(body.length).toBeLessThan(MAX_BODY_CHARS);
    expect(body.split('\n').length).toBeLessThan(MAX_BODY_LINES);
  });

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))(
    '%s registry entry passes Agent Skills validation',
    (trigger) => {
      const skill = BUILTIN_SKILLS.find((s) => s.trigger === trigger)!;
      expect(validateCommandTrigger(skill.trigger)).toEqual({ valid: true });
      expect(validateCommandDescription(skill.description)).toEqual({ valid: true });
    }
  );

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))('%s body is substantive markdown', (trigger) => {
    const body = getSkillBody(trigger)!;
    // A body that lost its content in a refactor should fail loudly, not
    // ship as an empty instruction pack.
    expect(body.length).toBeGreaterThan(2_000);
    expect(body).toContain('## ');
  });
});

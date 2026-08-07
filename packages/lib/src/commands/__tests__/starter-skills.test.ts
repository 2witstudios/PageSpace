import { describe, it, expect } from 'vitest';
import {
  isReservedTrigger,
  validateCommandDescription,
  validateCommandTrigger,
  COMMAND_TRIGGER_MAX_LENGTH,
} from '../command-core';
import { STARTER_SKILLS, STARTER_SKILL_TRIGGERS, STARTER_SKILLS_FOLDER_TITLE } from '../starter-skills';

/**
 * Starter skills install as user-owned commands, so they must satisfy exactly
 * what the commands API would demand of a hand-created one — the installer
 * writes rows directly and would otherwise bypass that validation.
 *
 * Size guards mirror the built-in skill bodies (skill-bodies.test.ts): a body is
 * a focused instruction pack, not a reference dump.
 */
const MAX_BODY_CHARS = 20_000;
const MIN_BODY_CHARS = 2_000;
const MAX_BODY_LINES = 500;

/**
 * A personal command rides the volatile AVAILABLE COMMANDS block, which clips
 * descriptions at 200 chars before degrading the whole list to shorter clips.
 * Keeping starters under that keeps the user's OWN commands off the degradation
 * ladder.
 */
const MAX_DESCRIPTION_CHARS = 200;

describe('starter skills', () => {
  it('ships at least one starter skill', () => {
    expect(STARTER_SKILLS.length).toBeGreaterThan(0);
  });

  it('exposes a folder title for the installer', () => {
    expect(STARTER_SKILLS_FOLDER_TITLE).toBe('Skills');
  });

  it('has no duplicate triggers', () => {
    expect(new Set(STARTER_SKILL_TRIGGERS).size).toBe(STARTER_SKILL_TRIGGERS.length);
  });

  it('STARTER_SKILL_TRIGGERS matches STARTER_SKILLS', () => {
    expect([...STARTER_SKILL_TRIGGERS].sort()).toEqual(STARTER_SKILLS.map((s) => s.trigger).sort());
  });

  it.each(STARTER_SKILLS.map((s) => s.trigger))('%s passes Agent Skills trigger validation', (trigger) => {
    expect(validateCommandTrigger(trigger)).toEqual({ valid: true });
    expect(trigger.length).toBeLessThanOrEqual(COMMAND_TRIGGER_MAX_LENGTH);
  });

  it.each(STARTER_SKILLS.map((s) => s.trigger))(
    '%s does not collide with a reserved built-in trigger',
    (trigger) => {
      // A reserved trigger would make the installed command permanently
      // shadowed (builtin > user), i.e. installed but uninvokable.
      expect(isReservedTrigger(trigger)).toBe(false);
    },
  );

  it.each(STARTER_SKILLS.map((s) => [s.trigger, s.description] as const))(
    '%s has a valid, budget-sized description',
    (_trigger, description) => {
      expect(validateCommandDescription(description)).toEqual({ valid: true });
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    },
  );

  it.each(STARTER_SKILLS.map((s) => [s.trigger, s.body] as const))(
    '%s body respects the skill size guards',
    (_trigger, body) => {
      expect(body.length).toBeGreaterThan(MIN_BODY_CHARS);
      expect(body.length).toBeLessThan(MAX_BODY_CHARS);
      expect(body.split('\n').length).toBeLessThan(MAX_BODY_LINES);
    },
  );

  it.each(STARTER_SKILLS.map((s) => [s.trigger, s.body] as const))(
    '%s body is structured markdown ending in a pitfalls section',
    (_trigger, body) => {
      expect(body).toContain('## ');
      // Every skill body in the codebase closes with the pitfalls list; it is
      // where the non-obvious traps live, so a body that lost it in an edit
      // should fail loudly.
      expect(body).toContain('## Common pitfalls');
    },
  );

  it.each(STARTER_SKILLS.map((s) => [s.trigger, s.title] as const))(
    '%s has a non-empty page title',
    (_trigger, title) => {
      expect(title.trim().length).toBeGreaterThan(0);
    },
  );
});

describe('plan starter skill', () => {
  const plan = STARTER_SKILLS.find((s) => s.trigger === 'plan');

  it('exists', () => {
    expect(plan).toBeDefined();
  });

  it('tells the agent to bind the plan, which is what survives compaction', () => {
    expect(plan!.body).toContain('set_plan');
  });

  it('documents both plan destinations', () => {
    // The epic left "where does the plan page live" unresolved; the body is
    // where that decision is now recorded, so assert both halves of it.
    expect(plan!.body).toContain('Plans');
    expect(plan!.body).toContain('Home drive');
  });

  it('hands task mechanics off rather than duplicating them', () => {
    expect(plan!.body).toContain('load_skill("task-management")');
  });
});

/**
 * Instruction tests.
 *
 * Two things matter here, and they used to be one. The call now carries the
 * real agent system prompt — which is what made it possible to delegate to at
 * all — and this module adds only what is different because the words are
 * heard. So the cases are: the shared prompt arrives intact, and the spoken
 * override sits after it and says what it overrides.
 */

import { describe, expect, it } from 'vitest';
import { buildVoiceInstructions } from '../instructions';

/** Stands in for whatever `buildAgentSystemPrompt` produced for this binding. */
const AGENT_PROMPT = '# PAGESPACE AI\n\nYou are PageSpace AI. <<SHARED>>';

/** An ordinary agent: the split deferred something, so discovery exists. */
const FULL_REACH = {
  exposed: ['read_page', 'tool_search', 'execute_tool'],
  reachable: ['read_page', 'create_task', 'spawn_session'],
};

/**
 * An agent allowed only core tools. `applyToolExposureMode` registers no
 * scaffolding when there is nothing to defer, so `tool_search` and
 * `execute_tool` genuinely are not there.
 */
const CORE_ONLY_REACH = { exposed: ['read_page'], reachable: ['read_page'] };

const build = (
  over: {
    agentSystemPrompt?: string;
    title?: string;
    tools?: { exposed: string[]; reachable: string[] };
  } = {},
) => buildVoiceInstructions({ agentSystemPrompt: AGENT_PROMPT, tools: FULL_REACH, ...over });

describe('buildVoiceInstructions', () => {
  it('should carry the shared agent prompt VERBATIM', () => {
    // The call is the same agent as the typed surface. Summarising or trimming
    // the prompt here would make it a different one that merely sounds similar.
    expect(build()).toContain(AGENT_PROMPT);
  });

  it('should put the shared prompt FIRST and the spoken override after it', () => {
    // The override names rules it reverses, so it has to come after the thing
    // stating them — a contradiction resolved in the wrong order is just a
    // contradiction, and gpt-realtime degrades on those specifically.
    const instructions = build();

    expect(instructions.indexOf('<<SHARED>>')).toBeLessThan(
      instructions.indexOf('# THIS IS A VOICE CALL'),
    );
  });

  it('should say plainly that it overrides what came before', () => {
    expect(build()).toMatch(/OVERRIDE/);
    expect(build()).toContain('Everything above still applies EXCEPT');
  });

  it('should reverse "skip preambles" by name rather than just contradicting it', () => {
    // The typed prompt says to skip preambles; a call needs a short line before
    // a slow tool or the caller hears silence and assumes it dropped. Left
    // unnamed, this is two rules arguing.
    expect(build()).toContain('"Skip preambles" does NOT apply here');
  });

  it('should tell the model this is spoken, and what a spoken turn costs', () => {
    const instructions = build();

    expect(instructions).toContain('heard, not read');
    expect(instructions).toMatch(/two or three sentences/i);
    expect(instructions).toMatch(/markdown/i);
    expect(instructions).toMatch(/interrupt/i);
  });

  it('should tell it to ACT rather than ask permission', () => {
    // The model's default posture is to confirm before calling a tool, which on
    // a call reads as an assistant that will not do anything.
    expect(build()).toContain('DO NOT ASK PERMISSION TO USE A TOOL');
  });

  it('should tell it not to give up after one empty result, and when to stop', () => {
    const instructions = build();

    expect(instructions).toContain('An empty search is not an answer');
    expect(instructions).toContain('IF THE SAME TOOL FAILS TWICE ON THE SAME TASK');
  });

  it('should send it to tool_search before it claims something is impossible', () => {
    // Most tools are deferred. Without this the model refuses requests it is
    // holding the tools for.
    expect(build()).toContain('NEVER SAY SOMETHING IS IMPOSSIBLE BEFORE YOU HAVE CALLED tool_search');
  });

  it('given NO discovery tools, should not send it to a tool_search that is not there', () => {
    // An agent allowed only core tools is registered no scaffolding at all, so
    // this rule would order a call to a tool the session never advertised —
    // spent out loud, in front of someone waiting.
    const instructions = build({ tools: CORE_ONLY_REACH });

    expect(instructions).not.toContain('tool_search');
    expect(instructions).not.toContain('execute_tool');
    expect(instructions).toContain('Every tool you have is already listed for you');
  });

  it('should name where long work goes, so a call is not four minutes of silence', () => {
    const instructions = build();

    expect(instructions).toContain('spawn_session');
    expect(instructions).toContain('create_task');
  });

  it('given only one hand-off tool, should name that one and not the others', () => {
    const instructions = build({
      tools: { exposed: ['read_page', 'tool_search'], reachable: ['read_page', 'create_task'] },
    });

    expect(instructions).toContain('create_task');
    expect(instructions).not.toContain('spawn_session');
    expect(instructions).not.toContain('a trigger or a workflow');
  });

  it('should offer deferred work when EITHER a trigger or a workflow is reachable', () => {
    // One phrase covers two tools because it names a destination, not a call.
    // An agent that can set a trigger but not build a workflow can still be told
    // that work may happen later.
    for (const name of ['set_task_trigger', 'create_workflow']) {
      const instructions = build({
        tools: { exposed: ['read_page', 'tool_search'], reachable: ['read_page', name] },
      });

      expect(instructions, name).toContain('a trigger or a workflow for work that should happen later');
    }
  });

  it('given NO way to hand work off, should say to work through it instead of naming absent tools', () => {
    const instructions = build({ tools: CORE_ONLY_REACH });

    expect(instructions).not.toContain('spawn_session');
    expect(instructions).not.toContain('create_task');
    expect(instructions).toContain('work through it in steps');
  });

  it('should say the page id can be omitted, rather than asking the caller for one', () => {
    // The caller cannot read an id aloud and does not have one. The tools
    // resolve "this page" from the live location when the id is absent.
    const instructions = build();

    expect(instructions).toContain('with NO page id');
    expect(instructions).toContain('Never ask the caller for an id');
  });

  it('should send ask_user out loud instead of drawing a card nobody can see', () => {
    expect(build()).toContain('ask_user draws a card on a screen and does not work here');
  });

  it('should ask for clarification on unintelligible audio rather than guessing', () => {
    const instructions = build();

    expect(instructions).toContain('unintelligible');
    expect(instructions).toContain('Do not guess at what was said');
  });

  it('should tell it to vary its phrasing', () => {
    expect(build()).toContain('Never reuse the same opener');
  });

  it('given a bound agent, should address it by the name the user picked', () => {
    // The typed surface never names the agent because the user can see which
    // one they opened. On a call, being called by that name is most of what
    // makes it feel like the assistant they chose.
    expect(build({ title: 'Release Notes Bot' })).toContain('"Release Notes Bot"');
  });

  it('given no bound agent, should still say it is speaking out loud', () => {
    const instructions = build();

    expect(instructions).toContain('speaking with someone out loud');
    expect(instructions).not.toContain('""');
  });

  it('should say its own tool results outrank the standing instructions it was given', () => {
    // The instructions are assembled at socket open and never re-sent, so a
    // block describing mutable state goes stale the moment the model mutates
    // it. The ACTIVE PLAN pointer is the sharp case: it is a directive ("keep
    // working against this page, re-read it before continuing"), so after a
    // clear_plan on the call the model would otherwise go on being told to
    // resume a plan the caller just ended. Its own tool result is the one
    // channel that CAN correct the record mid-call, so it is named as
    // authoritative.
    const instructions = build();

    expect(instructions).toContain('YOUR OWN TOOL RESULT IS WHAT IS CURRENT');
    expect(instructions).toContain('Never re-follow a standing instruction about something you have since changed');
  });

  it('should carry NOTHING turn-volatile — instructions are sent once, at socket open', () => {
    // There is no path that sends a second session.update, so a location baked
    // in here becomes a lie the moment the caller walks to another page. The
    // tools read the live location instead.
    const instructions = build();

    expect(instructions).not.toContain('LOCATION CONTEXT');
    expect(instructions).not.toMatch(/CURRENT (DATE|TIME)/i);
  });

  it('should be pure — same input, same output, nothing accumulated between calls', () => {
    const input = { agentSystemPrompt: AGENT_PROMPT, title: 'Bot' };

    expect(buildVoiceInstructions(input)).toBe(buildVoiceInstructions(input));
  });

  it('should never come back empty', () => {
    // An empty `instructions` on a session.update REPLACES the session's, so a
    // builder that can return '' is a builder that can erase a persona.
    for (const input of [{}, { title: 'Bot' }, { agentSystemPrompt: '' }]) {
      expect(build(input).trim().length).toBeGreaterThan(0);
    }
  });
});

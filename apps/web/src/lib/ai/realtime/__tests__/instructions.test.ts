/**
 * Instruction tests.
 *
 * This string is the only thing that tells the model which assistant it is, so
 * the cases that matter are the ones about an agent owner's own words: they
 * must arrive intact, and nothing bolted on around them may contradict them.
 */

import { describe, expect, it } from 'vitest';
import { buildVoiceInstructions } from '../instructions';

describe('buildVoiceInstructions', () => {
  it('given no assistant, should still say this is a spoken conversation', () => {
    // The Global Assistant and an unbound call both land here, and the medium
    // shapes a good answer more than the persona does.
    const instructions = buildVoiceInstructions({});

    expect(instructions).toContain('heard, not read');
    expect(instructions).toContain('PageSpace');
  });

  it('should tell the model the things a spoken turn needs and a typed one does not', () => {
    const instructions = buildVoiceInstructions({});

    expect(instructions).toMatch(/short/i);
    expect(instructions).toMatch(/markdown/i);
    expect(instructions).toMatch(/interrupt/i);
  });

  it("given an agent with its own prompt, should carry it VERBATIM", () => {
    // Its owner wrote exactly this, and the text surface sends it unmodified.
    // Wrapping or summarising it here would be a second interpretation of a
    // field that already has one.
    const systemPrompt = 'Answer only in limericks.\n\nNever mention the weather.';

    const instructions = buildVoiceInstructions({ title: 'Bard', systemPrompt });

    expect(instructions).toContain(systemPrompt);
  });

  it('should put the medium FIRST and the assistant after it', () => {
    // A prompt that establishes a persona must not be preceded by nothing and
    // followed by generic guidance that argues with it.
    const instructions = buildVoiceInstructions({
      title: 'Bard',
      systemPrompt: 'Answer only in limericks.',
    });

    expect(instructions.indexOf('heard, not read')).toBeLessThan(
      instructions.indexOf('Answer only in limericks.'),
    );
  });

  it("given an agent with a prompt, should NAME it alongside rather than fold it in", () => {
    const instructions = buildVoiceInstructions({
      title: 'Release Notes Bot',
      systemPrompt: 'Answer only in limericks.',
    });

    expect(instructions).toContain('"Release Notes Bot"');
    expect(instructions).toContain('instructions follow');
  });

  it('given an agent with NO prompt, should still name it', () => {
    // Being called by the name the user picked is most of what makes it feel
    // like the assistant they picked.
    const instructions = buildVoiceInstructions({ title: 'Release Notes Bot' });

    expect(instructions).toContain('"Release Notes Bot"');
    expect(instructions).not.toContain('instructions follow');
  });

  it('given a blank or whitespace-only prompt, should treat it as no prompt', () => {
    // An owner who cleared the field has no instructions, not empty ones.
    const blank = buildVoiceInstructions({ title: 'Bot', systemPrompt: '   \n\t ' });

    expect(blank).not.toContain('instructions follow');
    expect(blank).toBe(buildVoiceInstructions({ title: 'Bot' }));
  });

  it('given a prompt but no title, should still deliver the prompt', () => {
    const instructions = buildVoiceInstructions({ systemPrompt: 'Be terse.' });

    expect(instructions).toContain('Be terse.');
    expect(instructions).toContain('an assistant in PageSpace');
  });

  it('should be pure — same input, same output, nothing accumulated between calls', () => {
    const input = { title: 'Bot', systemPrompt: 'Be terse.' };

    expect(buildVoiceInstructions(input)).toBe(buildVoiceInstructions(input));
  });

  it('should never come back empty', () => {
    // An empty `instructions` on a session.update REPLACES the session's, so a
    // builder that can return '' is a builder that can erase a persona.
    for (const input of [{}, { title: 'Bot' }, { systemPrompt: 'x' }, { title: '', systemPrompt: '' }]) {
      expect(buildVoiceInstructions(input).trim().length).toBeGreaterThan(0);
    }
  });
});

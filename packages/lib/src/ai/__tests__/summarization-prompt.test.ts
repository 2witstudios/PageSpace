import { describe, it, expect } from 'vitest';
import { buildSummarizationPrompt } from '../summarization-prompt';

describe('buildSummarizationPrompt', () => {
  const TRANSCRIPT = [
    { role: 'user', parts: [{ type: 'text', text: 'Create a PageSpace page for our team wiki.' }] },
    {
      role: 'assistant',
      parts: [{ type: 'text', text: 'Done! Page id=abc123.' }],
    },
  ];

  it('returns system and prompt strings', () => {
    const { system, prompt } = buildSummarizationPrompt({
      previousSummary: null,
      transcript: TRANSCRIPT,
      maxSummaryTokens: 2000,
    });
    expect(typeof system).toBe('string');
    expect(typeof prompt).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes all mandatory section headings', () => {
    const { prompt } = buildSummarizationPrompt({
      previousSummary: null,
      transcript: TRANSCRIPT,
      maxSummaryTokens: 2000,
    });
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/intent/);
    expect(lower).toMatch(/fact|concept/);
    expect(lower).toMatch(/rule|constraint/);
    expect(lower).toMatch(/person|entit/);
    expect(lower).toMatch(/artifact/);
    expect(lower).toMatch(/error|fix/);
    expect(lower).toMatch(/decision/);
    expect(lower).toMatch(/pending|task/);
    expect(lower).toMatch(/current state|next step/);
  });

  it('instructs VERBATIM preservation of rules/constraints', () => {
    const { prompt } = buildSummarizationPrompt({
      previousSummary: null,
      transcript: TRANSCRIPT,
      maxSummaryTokens: 2000,
    });
    expect(prompt.toLowerCase()).toMatch(/verbatim/);
  });

  it('includes transcript content in the prompt', () => {
    const { prompt } = buildSummarizationPrompt({
      previousSummary: null,
      transcript: TRANSCRIPT,
      maxSummaryTokens: 2000,
    });
    expect(prompt).toContain('PageSpace');
  });

  it('includes token cap instruction', () => {
    const { prompt } = buildSummarizationPrompt({
      previousSummary: null,
      transcript: TRANSCRIPT,
      maxSummaryTokens: 1234,
    });
    expect(prompt).toContain('1234');
  });

  it('uses progressive framing when previousSummary is present', () => {
    const { prompt } = buildSummarizationPrompt({
      previousSummary: 'Earlier: user set up a project page.',
      transcript: TRANSCRIPT,
      maxSummaryTokens: 2000,
    });
    expect(prompt).toContain('Earlier: user set up a project page.');
    expect(prompt.toLowerCase()).toMatch(/previous|prior|earlier|extend|update/);
  });

  it('describes artifacts with restorable pointers', () => {
    const transcriptWithPageId = [
      ...TRANSCRIPT,
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Now edit page abc123.' }],
      },
    ];
    const { prompt } = buildSummarizationPrompt({
      previousSummary: null,
      transcript: transcriptWithPageId,
      maxSummaryTokens: 2000,
    });
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/read_page|re-read/);
  });
});

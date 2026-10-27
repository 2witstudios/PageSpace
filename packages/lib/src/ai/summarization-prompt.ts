interface TranscriptPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

interface TranscriptMessage {
  role: string;
  parts?: TranscriptPart[];
}

export interface BuildSummarizationPromptParams {
  previousSummary: string | null;
  transcript: TranscriptMessage[];
  maxSummaryTokens: number;
}

export interface SummarizationPrompt {
  system: string;
  prompt: string;
}

function renderTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      const text = (msg.parts ?? [])
        .map((p) => {
          if (p.type === 'text') return p.text ?? '';
          if (p.type === 'tool-call') {
            return `[tool_call: ${p.toolName ?? ''}(${JSON.stringify(p.args ?? {})})]`;
          }
          if (p.type === 'tool-result') {
            const out =
              typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? '');
            return `[tool_result: ${out.slice(0, 500)}${out.length > 500 ? '...' : ''}]`;
          }
          return '';
        })
        .join('\n');
      return `${role}: ${text}`;
    })
    .join('\n\n');
}

export function buildSummarizationPrompt(
  params: BuildSummarizationPromptParams
): SummarizationPrompt {
  const { previousSummary, transcript, maxSummaryTokens } = params;

  const system = [
    'You are a precise conversation summarizer. Your task is to produce a structured summary',
    'of an AI agent conversation that preserves everything the agent needs to continue working',
    'effectively. Be exhaustive but concise. Reproduce rules and constraints VERBATIM.',
  ].join(' ');

  const sections = [
    '## Intent',
    'What is the user ultimately trying to accomplish?',
    '',
    '## Key Facts & Concepts',
    'Important facts, domain knowledge, and context established in this conversation.',
    '',
    '## Rules & Constraints (VERBATIM)',
    'Reproduce any rules, constraints, instructions, or requirements the user stated WORD FOR WORD.',
    '',
    '## People & Entities',
    'Named users, agents, systems, or organizations mentioned and their roles.',
    '',
    '## Artifacts & Restorable Pointers',
    'Pages, files, and resources created or referenced. For each page use: page `<id>` — re-read via read_page.',
    '',
    '## Errors & Fixes',
    'Any errors encountered and how they were resolved.',
    '',
    '## Decisions',
    'Choices made, trade-offs accepted, approaches ruled out.',
    '',
    '## Pending Tasks',
    'Work that was started but not finished, or explicitly queued for later.',
    '',
    '## Current State & Next Step',
    'Where things stand right now, and what the immediate next action is.',
  ].join('\n');

  const previousBlock = previousSummary
    ? [
        '## Previous Summary (extend and update this, do not repeat it verbatim)',
        previousSummary,
        '',
      ].join('\n')
    : '';

  const transcriptBlock = [
    previousSummary
      ? '## New Conversation Transcript (since previous summary)'
      : '## Conversation Transcript',
    renderTranscript(transcript),
  ].join('\n');

  const tokenCapInstruction = [
    '',
    `Produce a summary using at most ${maxSummaryTokens} tokens.`,
    'Output ONLY the summary — no preamble, no meta-commentary.',
  ].join('\n');

  const prompt = [
    previousBlock,
    transcriptBlock,
    '',
    'Fill in each section below. If a section has no content, write "None."',
    '',
    sections,
    tokenCapInstruction,
  ]
    .filter(Boolean)
    .join('\n');

  return { system, prompt };
}

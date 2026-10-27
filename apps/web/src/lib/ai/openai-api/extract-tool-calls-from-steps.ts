interface ExtractedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: 'output-available' | 'input-available';
}

interface ExtractedToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  state: 'output-available';
}

export interface ExtractedToolData {
  toolCalls: ExtractedToolCall[];
  toolResults: ExtractedToolResult[];
}

function isStepLike(step: unknown): step is {
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; output: unknown }>;
} {
  if (typeof step !== 'object' || step === null) return false;
  const s = step as Record<string, unknown>;
  return Array.isArray(s.toolCalls) && Array.isArray(s.toolResults);
}

export function extractToolCallsFromSteps(steps: ReadonlyArray<unknown>): ExtractedToolData {
  const toolCalls: ExtractedToolCall[] = [];
  const toolResults: ExtractedToolResult[] = [];

  for (const step of steps) {
    if (!isStepLike(step)) continue;

    const resultIds = new Set(
      step.toolResults
        .filter((tr) => typeof (tr as Record<string, unknown>).toolCallId === 'string')
        .map((tr) => (tr as Record<string, unknown>).toolCallId as string),
    );

    for (const tc of step.toolCalls) {
      if (typeof tc.toolCallId !== 'string' || typeof tc.toolName !== 'string') continue;
      toolCalls.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: (tc.input as Record<string, unknown>) ?? {},
        state: resultIds.has(tc.toolCallId) ? 'output-available' : 'input-available',
      });
    }

    for (const tr of step.toolResults) {
      if (typeof tr.toolCallId !== 'string' || typeof tr.toolName !== 'string') continue;
      toolResults.push({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: tr.output,
        state: 'output-available',
      });
    }
  }

  return { toolCalls, toolResults };
}

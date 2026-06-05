type ToolCallEntry = {
  toolCallId: string;
  toolName: string;
};

type StepWithToolCalls = {
  toolCalls?: ToolCallEntry[];
};

// Uses the choices:[] pattern (same as OpenAI usage chunks) so standard
// OpenAI client libraries that iterate over choices[] see nothing and skip
// the event silently. PageSpace-aware clients read x_pagespace_tool_summary.
export const buildToolSummaryEvent = (steps: StepWithToolCalls[]): string | null => {
  const toolCalls: ToolCallEntry[] = steps.flatMap(step =>
    (step.toolCalls ?? []).map(tc => ({ toolCallId: tc.toolCallId, toolName: tc.toolName })),
  );

  if (toolCalls.length === 0) return null;

  return `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [],
    x_pagespace_tool_summary: { toolCalls, stepCount: steps.length },
  })}`;
};

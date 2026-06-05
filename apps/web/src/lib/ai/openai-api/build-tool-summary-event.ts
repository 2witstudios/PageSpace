type ToolCallEntry = {
  toolCallId: string;
  toolName: string;
};

type StepWithToolCalls = {
  toolCalls: ToolCallEntry[];
};

export const buildToolSummaryEvent = (steps: StepWithToolCalls[]): string | null => {
  const toolCalls: ToolCallEntry[] = steps.flatMap(step =>
    step.toolCalls.map(tc => ({ toolCallId: tc.toolCallId, toolName: tc.toolName })),
  );

  if (toolCalls.length === 0) return null;

  return `event: PAGESPACE_TOOL_SUMMARY\ndata: ${JSON.stringify({ toolCalls, stepCount: steps.length })}`;
};

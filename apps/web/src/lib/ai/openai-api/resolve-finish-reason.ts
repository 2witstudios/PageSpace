export const resolveFinishReason = (
  hadToolCallInStep: boolean,
  isFinalStep: boolean,
): 'tool_calls' | 'stop' => {
  if (hadToolCallInStep && !isFinalStep) return 'tool_calls';
  return 'stop';
};

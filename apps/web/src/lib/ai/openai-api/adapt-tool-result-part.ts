type ToolOutputPart = {
  toolCallId: string;
  output: unknown;
};

type OpenAIChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role: 'tool'; tool_call_id: string; content: string };
    finish_reason: null;
  }>;
};

const serializeOutput = (output: unknown): string => {
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
};

export const adaptToolResultPart = (
  part: ToolOutputPart,
  chunkId: string,
  model: string,
  created: number,
): OpenAIChunk => ({
  id: chunkId,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [
    {
      index: 0,
      delta: {
        role: 'tool',
        tool_call_id: part.toolCallId,
        content: serializeOutput(part.output),
      },
      finish_reason: null,
    },
  ],
});

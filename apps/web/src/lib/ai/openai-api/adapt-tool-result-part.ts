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
    delta: { role: 'tool'; tool_call_id: string; tool_result: string };
    finish_reason: null;
  }>;
};

// Uses 'tool_result' instead of 'content' so standard OpenAI clients that
// concatenate every delta.content field do not mix tool outputs into the
// displayed assistant text. PageSpace-aware clients read 'tool_result'.
const serializeOutput = (output: unknown): string => {
  if (typeof output === 'string') return output;
  try {
    const serialized = JSON.stringify(output);
    return serialized === undefined ? '' : serialized;
  } catch {
    return String(output);
  }
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
        tool_result: serializeOutput(part.output),
      },
      finish_reason: null,
    },
  ],
});

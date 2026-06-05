type ToolInputPart = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type OpenAIChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      tool_calls: Array<{
        index: number;
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: null;
  }>;
};

export const adaptToolInputPart = (
  part: ToolInputPart,
  chunkId: string,
  model: string,
  created: number,
  toolIndex: number,
): OpenAIChunk => ({
  id: chunkId,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: toolIndex,
            id: part.toolCallId,
            type: 'function',
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.input),
            },
          },
        ],
      },
      finish_reason: null,
    },
  ],
});

import { tool } from 'ai';
import { z } from 'zod';

export const FINISH_TOOL_NAME = 'finish';

export const finishTool = {
  [FINISH_TOOL_NAME]: tool({
    description:
      'Call this tool when you have completed the user\'s request and have no more actions to take. This signals that your work is done.',
    inputSchema: z.object({
      reason: z
        .string()
        .optional()
        .describe('Brief internal note on why you are finishing (not shown to user)'),
    }),
    execute: async ({ reason }) => {
      return { done: true, reason: reason ?? 'Task completed' };
    },
  }),
};

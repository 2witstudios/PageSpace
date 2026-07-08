import { tool } from 'ai';
import { z } from 'zod';

export const ASK_USER_TOOL_NAME = 'ask_user';

const askUserOptionSchema = z.object({
  label: z.string().min(1).max(60).describe('Short button label (1-5 words)'),
  description: z
    .string()
    .max(300)
    .optional()
    .describe('One-line explanation of what choosing this option means'),
});

const askUserQuestionSchema = z.object({
  header: z
    .string()
    .min(1)
    .max(24)
    .describe('Very short chip/tag shown on the card, e.g. "Auth method"'),
  question: z.string().min(1).max(500).describe('The complete question to ask the user'),
  options: z
    .array(askUserOptionSchema)
    .min(2)
    .max(4)
    .describe('Distinct, mutually exclusive choices. Do not add a catch-all option; the UI provides a free-text "Other" automatically.'),
});

export const askUserInputSchema = z.object({
  questions: z.array(askUserQuestionSchema).min(1).max(4),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

/**
 * Output shape produced by the CLIENT (the tool has no execute). The server
 * validates any client-supplied output against this schema before merging it
 * into the persisted assistant message; the length caps bound what an
 * answering client can inject into model context.
 */
const askUserAnswerSchema = z
  .object({
    header: z.string().max(24),
    question: z.string().max(500),
    selectedLabel: z.string().max(60).optional(),
    otherText: z.string().max(2000).optional(),
  })
  .refine((answer) => answer.selectedLabel !== undefined || answer.otherText !== undefined, {
    message: 'Each answer needs a selected option or free-text input',
  });

export const askUserOutputSchema = z.union([
  z.object({ answers: z.array(askUserAnswerSchema).min(1).max(4) }),
  z.object({ dismissed: z.literal(true), reason: z.string().max(500) }),
]);

export type AskUserOutput = z.infer<typeof askUserOutputSchema>;
export type AskUserAnswer = z.infer<typeof askUserAnswerSchema>;

/**
 * Client-side tool: no execute. Calling it ends the agent turn with the tool
 * call left open (state input-available); the turn resumes when the user
 * answers in the chat UI and the answer is merged in as the tool result.
 * Injected at route level for app admins only (see ask-user-gating.ts) —
 * intentionally NOT part of baseTools/pageSpaceTools so it never enters the
 * tool_search catalog or the execute_tool dispatch map.
 */
export const askUserTools = {
  ask_user: tool({
    description:
      'Ask the user 1-4 multiple-choice questions and wait for their answers before continuing. ' +
      'Use this only when you are blocked on a decision you cannot resolve yourself: ambiguous requirements, ' +
      'mutually exclusive approaches, or destructive/irreversible choices. Never ask something you can look up ' +
      'with your other tools. Each question offers 2-4 concise options; the UI automatically adds a free-text ' +
      '"Other" option, so do not include a catch-all option yourself. After calling this tool, STOP — do not call ' +
      'finish or any other tool; your turn ends and resumes when the user responds. The result may be ' +
      '{"dismissed": true} if the user replied in chat instead of selecting an option — treat their chat message ' +
      'as the answer.',
    inputSchema: askUserInputSchema,
  }),
};

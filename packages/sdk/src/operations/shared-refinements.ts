/**
 * Refine predicates shared across operations whose `agentTrigger` shapes
 * otherwise legitimately differ — `calendar.ts` (nullable `instructionPageId`,
 * trims `prompt`) vs `tasks.ts` (adds `triggerType`) — but both require the
 * same underlying invariant: an agent trigger needs a prompt or an
 * instruction page to actually run.
 */
export function requirePromptOrInstructionPageId<T extends { prompt?: string; instructionPageId?: string | null }>(): [
  predicate: (value: T) => boolean,
  params: { message: string; path: ['prompt'] },
] {
  return [
    (value) => Boolean(value.prompt) || Boolean(value.instructionPageId),
    { message: 'agentTrigger needs either a prompt or an instructionPageId', path: ['prompt'] },
  ];
}

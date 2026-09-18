import { streamText, type LanguageModel } from 'ai';

const MAX_SNAPSHOT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 4_000;

export interface SnapshotMessage {
  role: string;
  status?: string | null;
  content: string;
  toolResults?: unknown;
}

export async function buildSideQuestionSnapshot({
  conversationId: _conversationId,
  readMessages,
  readPlan,
}: {
  conversationId: string;
  readMessages: () => Promise<SnapshotMessage[]>;
  readPlan: () => Promise<string | null>;
}): Promise<string> {
  const [messages, plan] = await Promise.all([readMessages(), readPlan()]);
  const completed = messages
    .filter((message) => message.status !== 'streaming' && message.status !== 'interrupted')
    .map((message) => `${message.role}: ${message.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n');
  // Tool results are represented only once their containing message is complete.
  // They remain in the persisted message content/parts; no running tool state enters this snapshot.
  return [`TRANSCRIPT (completed only):\n${completed}`, plan ? `PLAN: ${plan}` : 'PLAN: none']
    .join('\n\n')
    .slice(0, MAX_SNAPSHOT_CHARS);
}

export function createSideQuestionStream({
  model,
  question,
  snapshot,
  abortSignal,
  streamText: stream = streamText,
}: {
  model: LanguageModel;
  question: string;
  snapshot: string;
  abortSignal: AbortSignal;
  streamText?: typeof streamText;
}): Response {
  const result = stream({
    model,
    abortSignal,
    // Deliberately undefined: this detached path never receives the primary tool set.
    tools: undefined,
    prompt: `You are answering a detached side question. Answer only from the snapshot below. Do not claim to have performed actions, call tools, write data, or continue the main run. If the snapshot does not answer the question, say so.\n\n${snapshot}\n\nSIDE QUESTION: ${question}`,
  });
  return result.toTextStreamResponse();
}

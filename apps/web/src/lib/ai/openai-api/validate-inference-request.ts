import type { UIMessage } from 'ai';

export interface ValidatedInferenceRequest {
  pageId: string;
  messages: UIMessage[];
  stream: true;
  driveContext?: string;
}

export type ValidationResult =
  | { ok: true; data: ValidatedInferenceRequest }
  | { ok: false; status: number; error: string };

const AGENT_MODEL_PREFIX = 'ps-agent://';

export const parseAgentModelUri = (model: string): string | null => {
  if (!model.startsWith(AGENT_MODEL_PREFIX)) return null;
  const pageId = model.slice(AGENT_MODEL_PREFIX.length);
  return pageId || null;
};

/**
 * Normalize an incoming message (OpenAI SDK format or UIMessage) to UIMessage.
 * OpenAI SDK sends {role, content: string} without parts; extractMessageContent
 * and sanitizeMessagesForModel both read parts, so we must ensure parts is set.
 */
const normalizeMessage = (msg: Record<string, unknown>): UIMessage => {
  if (typeof msg !== 'object' || msg === null) {
    return { id: crypto.randomUUID(), role: 'user' as UIMessage['role'], parts: [] } as unknown as UIMessage;
  }
  if (Array.isArray(msg.parts)) {
    return msg as unknown as UIMessage;
  }
  const id = typeof msg.id === 'string' ? msg.id : crypto.randomUUID();
  const role = msg.role as UIMessage['role'];
  if (typeof msg.content === 'string') {
    return { id, role, parts: [{ type: 'text' as const, text: msg.content }] } as unknown as UIMessage;
  }
  if (Array.isArray(msg.content)) {
    const parts = (msg.content as Array<Record<string, unknown>>)
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => ({ type: 'text' as const, text: c.text as string }));
    return { id, role, parts } as unknown as UIMessage;
  }
  return { id, role, parts: [] } as unknown as UIMessage;
};

export const validateInferenceRequest = (body: unknown): ValidationResult => {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'request body must be a JSON object' };
  }

  const raw = body as Record<string, unknown>;

  if (!raw.model || typeof raw.model !== 'string') {
    return { ok: false, status: 400, error: 'model is required' };
  }

  const pageId = parseAgentModelUri(raw.model);
  if (!pageId) {
    return { ok: false, status: 400, error: 'unsupported model format — use ps-agent://<pageId>' };
  }

  if (raw.stream === false) {
    return { ok: false, status: 400, error: 'non-streaming responses not supported in v1' };
  }

  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, error: 'messages must be a non-empty array' };
  }

  const driveContext = typeof raw.drive_context === 'string' ? raw.drive_context : undefined;

  return {
    ok: true,
    data: {
      pageId,
      messages: messages.map(m => normalizeMessage(m as Record<string, unknown>)),
      stream: true,
      driveContext,
    },
  };
};

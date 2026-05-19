import type { UIMessage } from 'ai';
import { createId } from '@paralleldrive/cuid2';

export interface ValidatedInferenceRequest {
  pageId: string;
  model: string;
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

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

const normalizeMessage = (msg: Record<string, unknown>): UIMessage => {
  const id = typeof msg.id === 'string' ? msg.id : createId();
  if (Array.isArray(msg.parts)) {
    return { ...msg, id } as unknown as UIMessage;
  }
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

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) {
      return { ok: false, status: 400, error: 'each message must be an object' };
    }
    const role = (msg as Record<string, unknown>).role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return { ok: false, status: 400, error: 'each message role must be one of: user, assistant, system, tool' };
    }
  }

  const normalized = (messages as Record<string, unknown>[]).map(normalizeMessage);

  for (const msg of normalized) {
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) {
      return { ok: false, status: 400, error: 'each message must have non-empty content' };
    }
  }

  const driveContext = typeof raw.drive_context === 'string' ? raw.drive_context : undefined;

  return {
    ok: true,
    data: {
      pageId,
      model: raw.model,
      messages: normalized,
      stream: true,
      driveContext,
    },
  };
};

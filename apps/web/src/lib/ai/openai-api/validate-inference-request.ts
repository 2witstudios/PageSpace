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
      messages: messages as UIMessage[],
      stream: true,
      driveContext,
    },
  };
};

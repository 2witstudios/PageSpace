import type { UIMessage } from 'ai';
import { createId } from '@paralleldrive/cuid2';

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ValidatedInferenceRequest {
  pageId: string;
  model: string;
  messages: UIMessage[];
  stream: true;
  driveContext?: string;
  conversationId?: string;
  clientTools?: OpenAIToolDefinition[];
  disableServerTools?: boolean;
  clientManagesHistory?: boolean;
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

type NormalizeResult =
  | { ok: true; messages: UIMessage[] }
  | { ok: false; error: string };

// Normalizes a flat OpenAI-format messages array into UIMessage[].
// Handles the multi-turn client-tool pattern: an assistant message with `tool_calls`
// followed by one or more `role:"tool"` messages is collapsed into a single assistant
// UIMessage whose parts carry `type:"tool-<name>"` / `state:"output-available"` data
// (the same shape the streaming pipeline produces for server-side tools).
// Standalone role:tool messages with no preceding matched assistant are skipped.
const normalizeMessages = (rawMessages: Record<string, unknown>[]): NormalizeResult => {
  const result: UIMessage[] = [];
  let i = 0;

  while (i < rawMessages.length) {
    const msg = rawMessages[i];
    const role = msg.role as string;

    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const rawToolCalls = msg.tool_calls as Array<unknown>;

      // Validate each entry before dereferencing — malformed entries return 400, not 500.
      for (let idx = 0; idx < rawToolCalls.length; idx++) {
        const tc = rawToolCalls[idx] as Record<string, unknown>;
        const fn = tc?.function as Record<string, unknown> | undefined;
        if (
          typeof tc !== 'object' || tc === null ||
          typeof tc.id !== 'string' ||
          typeof fn !== 'object' || fn === null ||
          typeof fn.name !== 'string' ||
          typeof fn.arguments !== 'string'
        ) {
          return { ok: false, error: `tool_calls[${idx}] must have id (string), function.name (string), and function.arguments (string)` };
        }
      }

      const toolCalls = rawToolCalls as Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;

      // Collect immediately following role:tool messages and build a result map.
      // Use Map (not plain object) so user-supplied tool_call_id values cannot
      // pollute Object.prototype via keys like "__proto__".
      const toolResults = new Map<string, string>();
      let j = i + 1;
      while (j < rawMessages.length && rawMessages[j].role === 'tool') {
        const toolMsg = rawMessages[j];
        const toolCallId = typeof toolMsg.tool_call_id === 'string' ? toolMsg.tool_call_id : undefined;
        if (toolCallId) {
          toolResults.set(toolCallId, typeof toolMsg.content === 'string' ? toolMsg.content : '');
        }
        j++;
      }

      // Build parts: preserve any natural-language content first, then tool call parts.
      // OpenAI permits assistant messages with both `content` and `tool_calls`; dropping
      // the text would remove context that follow-up requests depend on.
      const parts: Array<Record<string, unknown>> = [];
      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const c of msg.content as Array<Record<string, unknown>>) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text) {
            parts.push({ type: 'text', text: c.text });
          }
        }
      }

      for (const tc of toolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* leave empty on bad JSON */ }
        const toolName = tc.function.name;

        if (toolResults.has(tc.id)) {
          parts.push({ type: `tool-${toolName}`, toolCallId: tc.id, toolName, input, state: 'output-available', output: toolResults.get(tc.id) });
        } else {
          parts.push({ type: `tool-${toolName}`, toolCallId: tc.id, toolName, input, state: 'input-available' });
        }
      }

      const id = typeof msg.id === 'string' ? msg.id : createId();
      result.push({ id, role: 'assistant', parts } as unknown as UIMessage);
      i = j; // skip the consumed role:tool messages
      continue;
    }

    // Standalone role:tool message without a preceding matched assistant — skip.
    if (role === 'tool') {
      i++;
      continue;
    }

    result.push(normalizeMessage(msg));
    i++;
  }

  return { ok: true, messages: result };
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

  const normalizeResult = normalizeMessages(messages as Record<string, unknown>[]);
  if (!normalizeResult.ok) {
    return { ok: false, status: 400, error: normalizeResult.error };
  }
  const normalized = normalizeResult.messages;

  for (const msg of normalized) {
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) {
      return { ok: false, status: 400, error: 'each message must have non-empty content' };
    }
  }

  const driveContext = typeof raw.drive_context === 'string' ? raw.drive_context : undefined;

  const conversationId = (typeof raw.conversation_id === 'string' && raw.conversation_id.trim()) || undefined;

  let clientTools: OpenAIToolDefinition[] | undefined;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      return { ok: false, status: 400, error: 'tools must be an array' };
    }
    const tools: OpenAIToolDefinition[] = [];
    for (const t of raw.tools as unknown[]) {
      if (typeof t !== 'object' || t === null) {
        return { ok: false, status: 400, error: 'each tool must be an object' };
      }
      const entry = t as Record<string, unknown>;
      if (entry.type !== 'function') {
        return { ok: false, status: 400, error: "tool type must be 'function'" };
      }
      const fn = entry.function;
      if (typeof fn !== 'object' || fn === null) {
        return { ok: false, status: 400, error: 'each tool must have a function object' };
      }
      const fnObj = fn as Record<string, unknown>;
      if (typeof fnObj.name !== 'string' || !fnObj.name) {
        return { ok: false, status: 400, error: 'each tool must have a function.name string' };
      }
      tools.push({
        type: 'function',
        function: {
          name: fnObj.name,
          description: typeof fnObj.description === 'string' ? fnObj.description : undefined,
          parameters: (typeof fnObj.parameters === 'object' && fnObj.parameters !== null)
            ? fnObj.parameters as Record<string, unknown>
            : undefined,
        },
      });
    }
    clientTools = tools.length > 0 ? tools : undefined;
  }

  const disableServerTools = raw.disable_server_tools === true;
  const clientManagesHistory = raw.client_manages_history === true;

  return {
    ok: true,
    data: {
      pageId,
      model: raw.model,
      messages: normalized,
      stream: true,
      driveContext,
      conversationId,
      clientTools,
      disableServerTools,
      clientManagesHistory,
    },
  };
};

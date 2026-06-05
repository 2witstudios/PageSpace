// Types

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  created_at: number;
}

export interface ConversationRow {
  id: string;
  userId: string;
  isActive: boolean;
  title: string | null;
  contextId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
  isActive: boolean;
}

export type CreateConversationResult =
  | { ok: true; data: { id: string; userId: string; title: string | null; type: 'client'; contextId: string | null; updatedAt: Date } }
  | { ok: false; status: number; error: string };

export type ConversationListQueryResult =
  | { ok: true; data: { userId: string; limit: number; offset: number; driveId: string | undefined } }
  | { ok: false; status: number; error: string };

export type ConversationAccessResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

// Pure functions

export function buildCreateConversationPayload(
  body: unknown,
  userId: string,
  allowedDriveIds: string[],
  id: string,
): CreateConversationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'request body must be a JSON object' };
  }

  const raw = body as Record<string, unknown>;

  let title: string | null = null;
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      return { ok: false, status: 400, error: 'title must be a string' };
    }
    title = raw.title.trim().slice(0, 255) || null;
  }

  let contextId: string | null = null;
  if (raw.drive_id !== undefined) {
    if (typeof raw.drive_id !== 'string' || !raw.drive_id.trim()) {
      return { ok: false, status: 400, error: 'drive_id must be a non-empty string' };
    }
    const driveId = raw.drive_id.trim();
    if (allowedDriveIds.length > 0 && !allowedDriveIds.includes(driveId)) {
      return { ok: false, status: 403, error: 'MCP token does not have access to the specified drive' };
    }
    contextId = driveId;
  }

  return {
    ok: true,
    data: { id, userId, title, type: 'client' as const, contextId, updatedAt: new Date() },
  };
}

export function buildConversationListQuery(
  userId: string,
  searchParams: URLSearchParams,
): ConversationListQueryResult {
  const limitStr = searchParams.get('limit');
  const offsetStr = searchParams.get('offset');

  const limit = limitStr !== null ? parseInt(limitStr, 10) : 20;
  const offset = offsetStr !== null ? parseInt(offsetStr, 10) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, status: 400, error: 'limit must be between 1 and 100' };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, status: 400, error: 'offset must be >= 0' };
  }

  const driveIdParam = searchParams.get('drive_id');
  const driveId = driveIdParam !== null ? driveIdParam : undefined;

  return { ok: true, data: { userId, limit, offset, driveId } };
}

export function validateConversationAccess(
  conversation: ConversationRow | null,
  userId: string,
): ConversationAccessResult {
  if (!conversation || !conversation.isActive) {
    return { ok: false, status: 404, message: 'Conversation not found' };
  }
  if (conversation.userId !== userId) {
    return { ok: false, status: 403, message: 'Access denied' };
  }
  return { ok: true };
}

function extractPlainText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
      if (typeof parsed.originalContent === 'string') return parsed.originalContent;
      if (Array.isArray(parsed.textParts) && parsed.textParts.length > 0) {
        return (parsed.textParts as string[]).filter((t): t is string => typeof t === 'string').join('');
      }
    }
  } catch {
    // plain text
  }
  return content;
}

function parseRawToolCalls(
  raw: unknown,
): Array<{ toolCallId: string; toolName: string; input: unknown }> {
  if (!raw) return [];
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : (() => {
        try {
          const parsed = JSON.parse(raw as string);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
  return arr.filter(
    (tc): tc is { toolCallId: string; toolName: string; input: unknown } =>
      typeof tc === 'object' &&
      tc !== null &&
      typeof (tc as Record<string, unknown>).toolCallId === 'string' &&
      typeof (tc as Record<string, unknown>).toolName === 'string',
  );
}

export function serializeMessageToOpenAI(row: MessageRow): OpenAIMessage {
  const role = row.role as 'user' | 'assistant' | 'system';
  const text = extractPlainText(row.content);

  const rawCalls = parseRawToolCalls(row.toolCalls);
  const toolCalls: OpenAIToolCall[] = rawCalls.map((tc) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    function: {
      name: tc.toolName,
      arguments:
        typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
    },
  }));

  const msg: OpenAIMessage = {
    id: row.id,
    role,
    content: text || null,
    created_at: Math.floor(row.createdAt.getTime() / 1000),
  };

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }

  return msg;
}

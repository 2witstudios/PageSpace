import { describe, test } from 'vitest';
import { assert } from './riteway';
import {
  buildCreateConversationPayload,
  buildConversationListQuery,
  validateConversationAccess,
  serializeMessageRowToMessages,
  type ConversationRow,
  type MessageRow,
} from '../v1-conversations';

const FIXED_DATE = new Date('2024-01-15T10:00:00.000Z');
const FIXED_UNIX = Math.floor(FIXED_DATE.getTime() / 1000);

// ─── buildCreateConversationPayload ───────────────────────────────────────────

describe('buildCreateConversationPayload', () => {
  test('null body returns 400', () => {
    const result = buildCreateConversationPayload(null, 'user-1', [], 'id-1');
    assert({
      given: 'null as the body',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('non-object body returns 400', () => {
    const result = buildCreateConversationPayload('a string', 'user-1', [], 'id-1');
    assert({
      given: 'a primitive string as the body',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('empty body creates conversation with defaults', () => {
    const result = buildCreateConversationPayload({}, 'user-1', [], 'cuid-123');
    assert({
      given: 'an empty body object',
      should: 'return ok:true with id, userId, null title, client type, null contextId',
      actual: result.ok ? { id: result.data.id, userId: result.data.userId, title: result.data.title, type: result.data.type, contextId: result.data.contextId } : 'error',
      expected: { id: 'cuid-123', userId: 'user-1', title: null, type: 'client', contextId: null },
    });
  });

  test('body with title trims and preserves it', () => {
    const result = buildCreateConversationPayload({ title: '  My Chat  ' }, 'user-1', [], 'id-1');
    assert({
      given: 'a body with a padded title',
      should: 'return ok:true with the title trimmed',
      actual: result.ok ? result.data.title : 'error',
      expected: 'My Chat',
    });
  });

  test('title trimming to empty string becomes null', () => {
    const result = buildCreateConversationPayload({ title: '   ' }, 'user-1', [], 'id-1');
    assert({
      given: 'a title containing only whitespace',
      should: 'set title to null',
      actual: result.ok ? result.data.title : 'error',
      expected: null,
    });
  });

  test('title longer than 255 chars is truncated', () => {
    const longTitle = 'a'.repeat(300);
    const result = buildCreateConversationPayload({ title: longTitle }, 'user-1', [], 'id-1');
    assert({
      given: 'a title with 300 characters',
      should: 'truncate to 255 characters',
      actual: result.ok ? result.data.title?.length : 'error',
      expected: 255,
    });
  });

  test('non-string title returns 400', () => {
    const result = buildCreateConversationPayload({ title: 42 }, 'user-1', [], 'id-1');
    assert({
      given: 'a numeric title',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('drive_id sets contextId', () => {
    const result = buildCreateConversationPayload({ drive_id: 'drive-abc' }, 'user-1', [], 'id-1');
    assert({
      given: 'a body with drive_id and an unscoped token (empty allowedDriveIds)',
      should: 'return ok:true with contextId set to the drive_id',
      actual: result.ok ? result.data.contextId : 'error',
      expected: 'drive-abc',
    });
  });

  test('drive_id in allowedDriveIds is accepted', () => {
    const result = buildCreateConversationPayload({ drive_id: 'drive-abc' }, 'user-1', ['drive-abc', 'drive-xyz'], 'id-1');
    assert({
      given: 'a drive_id that appears in the token\'s allowedDriveIds',
      should: 'return ok:true',
      actual: result.ok,
      expected: true,
    });
  });

  test('drive_id not in allowedDriveIds returns 403', () => {
    const result = buildCreateConversationPayload({ drive_id: 'drive-other' }, 'user-1', ['drive-abc'], 'id-1');
    assert({
      given: 'a drive_id that is not in the scoped token\'s allowedDriveIds',
      should: 'return ok:false with status 403',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 403 },
    });
  });

  test('empty allowedDriveIds (unscoped token) allows any drive_id', () => {
    const result = buildCreateConversationPayload({ drive_id: 'any-drive' }, 'user-1', [], 'id-1');
    assert({
      given: 'an unscoped token (empty allowedDriveIds array) with any drive_id',
      should: 'return ok:true — unscoped tokens have access to all drives',
      actual: result.ok,
      expected: true,
    });
  });

  test('empty string drive_id returns 400', () => {
    const result = buildCreateConversationPayload({ drive_id: '' }, 'user-1', [], 'id-1');
    assert({
      given: 'an empty string drive_id',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('non-string drive_id returns 400', () => {
    const result = buildCreateConversationPayload({ drive_id: 123 }, 'user-1', [], 'id-1');
    assert({
      given: 'a numeric drive_id',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });
});

// ─── buildConversationListQuery ───────────────────────────────────────────────

describe('buildConversationListQuery', () => {
  test('no params returns defaults', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams());
    assert({
      given: 'no query params',
      should: 'return ok:true with limit:20, offset:0, driveId:undefined',
      actual: result.ok ? result.data : 'error',
      expected: { userId: 'user-1', limit: 20, offset: 0, driveId: undefined },
    });
  });

  test('custom limit and offset are parsed', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('limit=10&offset=5'));
    assert({
      given: 'limit=10&offset=5',
      should: 'return ok:true with limit:10 and offset:5',
      actual: result.ok ? { limit: result.data.limit, offset: result.data.offset } : 'error',
      expected: { limit: 10, offset: 5 },
    });
  });

  test('limit over 100 returns 400', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('limit=101'));
    assert({
      given: 'limit=101',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('limit 0 returns 400', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('limit=0'));
    assert({
      given: 'limit=0',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('negative offset returns 400', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('offset=-1'));
    assert({
      given: 'offset=-1',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('non-numeric limit returns 400', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('limit=abc'));
    assert({
      given: 'limit=abc',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('drive_id param is forwarded as driveId', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('drive_id=drive-xyz'));
    assert({
      given: 'drive_id=drive-xyz',
      should: 'return ok:true with driveId set',
      actual: result.ok ? result.data.driveId : 'error',
      expected: 'drive-xyz',
    });
  });

  test('missing drive_id param yields undefined driveId', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('limit=5'));
    assert({
      given: 'no drive_id param',
      should: 'return driveId as undefined',
      actual: result.ok ? result.data.driveId : 'error',
      expected: undefined,
    });
  });

  test('limit exactly 100 is accepted', () => {
    const result = buildConversationListQuery('user-1', new URLSearchParams('limit=100'));
    assert({
      given: 'limit=100',
      should: 'return ok:true (boundary value)',
      actual: result.ok,
      expected: true,
    });
  });
});

// ─── validateConversationAccess ───────────────────────────────────────────────

describe('validateConversationAccess', () => {
  const makeConversation = (overrides: Partial<ConversationRow> = {}): ConversationRow => ({
    id: 'conv-1',
    userId: 'user-1',
    isActive: true,
    title: null,
    contextId: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  });

  test('null conversation returns 404', () => {
    const result = validateConversationAccess(null, 'user-1');
    assert({
      given: 'null conversation',
      should: 'return ok:false with status 404',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 404 },
    });
  });

  test('inactive conversation returns 404', () => {
    const result = validateConversationAccess(makeConversation({ isActive: false }), 'user-1');
    assert({
      given: 'an inactive conversation (isActive:false)',
      should: 'return ok:false with status 404',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 404 },
    });
  });

  test('conversation belonging to a different user returns 403', () => {
    const result = validateConversationAccess(makeConversation({ userId: 'other-user' }), 'user-1');
    assert({
      given: 'a conversation owned by a different user',
      should: 'return ok:false with status 403',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 403 },
    });
  });

  test('conversation owned by the requesting user returns ok:true', () => {
    const result = validateConversationAccess(makeConversation({ userId: 'user-1' }), 'user-1');
    assert({
      given: 'an active conversation owned by the requesting user',
      should: 'return ok:true',
      actual: result.ok,
      expected: true,
    });
  });
});

// ─── serializeMessageRowToMessages ───────────────────────────────────────────

describe('serializeMessageRowToMessages', () => {
  const makeRow = (overrides: Partial<MessageRow> = {}): MessageRow => ({
    id: 'msg-1',
    role: 'user',
    content: 'Hello',
    toolCalls: null,
    toolResults: null,
    createdAt: FIXED_DATE,
    isActive: true,
    ...overrides,
  });

  test('plain text user message serializes to OpenAI format', () => {
    const result = serializeMessageRowToMessages(makeRow({ content: 'Hello' }));
    assert({
      given: 'a plain text user message',
      should: 'return a single-element array with role, content, and unix created_at',
      actual: { count: result.length, role: result[0].role, content: result[0].content, created_at: result[0].created_at },
      expected: { count: 1, role: 'user', content: 'Hello', created_at: FIXED_UNIX },
    });
  });

  test('structured content message extracts plain text', () => {
    const structured = JSON.stringify({
      textParts: ['Structured text'],
      partsOrder: [{ index: 0, type: 'text' }],
      originalContent: 'Structured text',
    });
    const result = serializeMessageRowToMessages(makeRow({ content: structured }));
    assert({
      given: 'a message with structured JSON content',
      should: 'extract the text from originalContent',
      actual: result[0].content,
      expected: 'Structured text',
    });
  });

  test('assistant message with tool calls includes tool_calls array', () => {
    const toolCallsRaw = JSON.stringify([
      { toolCallId: 'call-1', toolName: 'read_page', input: { pageId: 'p-1' }, state: 'output-available' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: '', toolCalls: toolCallsRaw }));
    const msg = result[0];
    assert({
      given: 'an assistant message with serialized tool calls',
      should: 'include tool_calls in the output with the OpenAI function format',
      actual: 'tool_calls' in msg ? msg.tool_calls?.[0] : undefined,
      expected: {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_page', arguments: '{"pageId":"p-1"}' },
      },
    });
  });

  test('message without tool calls has no tool_calls field', () => {
    const result = serializeMessageRowToMessages(makeRow({ toolCalls: null }));
    assert({
      given: 'a message with no tool calls',
      should: 'not include a tool_calls key in the output',
      actual: 'tool_calls' in result[0],
      expected: false,
    });
  });

  test('tool calls stored as array (not JSON string) are handled', () => {
    const toolCallsArray = [
      { toolCallId: 'call-2', toolName: 'create_page', input: { title: 'T' }, state: 'output-available' },
    ];
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: '', toolCalls: toolCallsArray }));
    const msg = result[0];
    assert({
      given: 'tool calls stored as a JS array (not a JSON string)',
      should: 'still produce the correct tool_calls output',
      actual: 'tool_calls' in msg ? msg.tool_calls?.[0]?.function.name : undefined,
      expected: 'create_page',
    });
  });

  test('empty content becomes null', () => {
    const result = serializeMessageRowToMessages(makeRow({ content: '' }));
    assert({
      given: 'an empty content string',
      should: 'return content:null',
      actual: result[0].content,
      expected: null,
    });
  });

  test('createdAt is converted to unix timestamp in seconds', () => {
    const date = new Date('2024-06-01T12:00:00.000Z');
    const result = serializeMessageRowToMessages(makeRow({ createdAt: date }));
    assert({
      given: 'a specific createdAt date',
      should: 'convert to seconds since epoch',
      actual: result[0].created_at,
      expected: Math.floor(date.getTime() / 1000),
    });
  });

  test('message id is preserved', () => {
    const result = serializeMessageRowToMessages(makeRow({ id: 'specific-msg-id' }));
    assert({
      given: 'a message with a specific id',
      should: 'preserve the id in the output',
      actual: result[0].id,
      expected: 'specific-msg-id',
    });
  });

  test('assistant message with string tool result emits a role:tool message', () => {
    const toolResults = JSON.stringify([
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents here', state: 'output-available' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: 'Done', toolResults }));
    assert({
      given: 'an assistant message row with a string tool result in toolResults JSONB',
      should: 'return [assistantMsg, toolResultMsg] with role:tool and the raw string as content',
      actual: {
        count: result.length,
        secondRole: result[1].role,
        toolCallId: result[1].role === 'tool' ? result[1].tool_call_id : undefined,
        content: result[1].role === 'tool' ? result[1].content : undefined,
      },
      expected: { count: 2, secondRole: 'tool', toolCallId: 'tc-1', content: 'file contents here' },
    });
  });

  test('assistant message with object tool result JSON-stringifies the output', () => {
    const output = { exitCode: 0, stdout: 'hello' };
    const toolResults = JSON.stringify([
      { toolCallId: 'tc-2', toolName: 'Bash', output, state: 'output-available' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: '', toolResults }));
    assert({
      given: 'an assistant message row with an object tool result',
      should: 'JSON.stringify the output as the tool message content',
      actual: result[1].role === 'tool' ? result[1].content : undefined,
      expected: JSON.stringify(output),
    });
  });

  test('assistant message with multiple tool results emits multiple role:tool messages', () => {
    const toolResults = JSON.stringify([
      { toolCallId: 'tc-1', toolName: 'Read', output: 'content', state: 'output-available' },
      { toolCallId: 'tc-2', toolName: 'Bash', output: 'exit 0', state: 'output-available' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: 'ok', toolResults }));
    assert({
      given: 'an assistant message with two tool results',
      should: 'return 3 messages: 1 assistant + 2 role:tool',
      actual: {
        count: result.length,
        roles: result.map(m => m.role),
      },
      expected: { count: 3, roles: ['assistant', 'tool', 'tool'] },
    });
  });

  test('user message with toolResults does not emit role:tool messages', () => {
    const toolResults = JSON.stringify([
      { toolCallId: 'tc-1', toolName: 'Read', output: 'x', state: 'output-available' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'user', toolResults }));
    assert({
      given: 'a user-role message row that somehow has toolResults',
      should: 'return only 1 message (role:tool emission is assistant-only)',
      actual: result.length,
      expected: 1,
    });
  });

  test('assistant message with null toolResults emits no role:tool messages', () => {
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: 'hi', toolResults: null }));
    assert({
      given: 'an assistant message with null toolResults',
      should: 'return exactly 1 message',
      actual: result.length,
      expected: 1,
    });
  });

  test('failed tool result uses errorText as content instead of null', () => {
    const toolResults = JSON.stringify([
      { toolCallId: 'tc-err', toolName: 'Bash', output: null, state: 'output-error', errorText: 'command not found: foobar' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: '', toolResults }));
    assert({
      given: 'an assistant message row with an output-error tool result',
      should: 'emit a role:tool message using errorText as content',
      actual: result[1]?.role === 'tool' ? (result[1] as { content: string }).content : undefined,
      expected: 'command not found: foobar',
    });
  });

  test('failed tool result with no errorText falls back to JSON.stringify(null)', () => {
    const toolResults = JSON.stringify([
      { toolCallId: 'tc-err', toolName: 'Bash', output: null, state: 'output-error' },
    ]);
    const result = serializeMessageRowToMessages(makeRow({ role: 'assistant', content: '', toolResults }));
    assert({
      given: 'an output-error tool result with no errorText',
      should: 'emit a role:tool message with "null" as content',
      actual: result[1]?.role === 'tool' ? (result[1] as { content: string }).content : undefined,
      expected: 'null',
    });
  });
});

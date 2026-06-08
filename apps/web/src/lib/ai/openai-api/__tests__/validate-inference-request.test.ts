import { describe, test } from 'vitest';
import { assert } from './riteway';
import { validateInferenceRequest } from '../validate-inference-request';

describe('validateInferenceRequest', () => {
  test('valid request', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hello', parts: [{ type: 'text' as const, text: 'Hello' }] }];
    const body = { model: 'ps-agent://page-123', messages };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a valid ps-agent model URI and non-empty messages array',
      should: 'return ok:true with the parsed pageId, messages, stream:true, and no driveContext',
      actual: result,
      expected: { ok: true, data: { pageId: 'page-123', model: 'ps-agent://page-123', messages, stream: true, driveContext: undefined, clientTools: undefined, disableServerTools: false, clientManagesHistory: false } },
    });
  });

  test('missing model field', () => {
    const body = { messages: [{ role: 'user', content: 'Hi' }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with no model field',
      should: 'return ok:false with status 400 and a descriptive error',
      actual: result,
      expected: { ok: false, status: 400, error: 'model is required' },
    });
  });

  test('model with unsupported format', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a model string that does not start with ps-agent://',
      should: 'return ok:false with status 400 instructing the correct format',
      actual: result,
      expected: { ok: false, status: 400, error: 'unsupported model format — use ps-agent://<pageId>' },
    });
  });

  test('empty messages array', () => {
    const body = { model: 'ps-agent://page-123', messages: [] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an empty messages array',
      should: 'return ok:false with status 400',
      actual: result,
      expected: { ok: false, status: 400, error: 'messages must be a non-empty array' },
    });
  });

  test('missing messages field', () => {
    const body = { model: 'ps-agent://page-123' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with no messages field',
      should: 'return ok:false with status 400',
      actual: result,
      expected: { ok: false, status: 400, error: 'messages must be a non-empty array' },
    });
  });

  test('stream: false explicitly set', () => {
    const body = { model: 'ps-agent://page-123', messages: [{ role: 'user', content: 'Hi' }], stream: false };
    const result = validateInferenceRequest(body);
    assert({
      given: 'stream: false in the request body',
      should: 'return ok:false with status 400 because v1 is streaming-only',
      actual: result,
      expected: { ok: false, status: 400, error: 'non-streaming responses not supported in v1' },
    });
  });

  test('drive_context forwarded as driveContext', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, drive_context: 'drive-abc' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with a drive_context field',
      should: 'include driveContext in the parsed data',
      actual: result.ok ? result.data.driveContext : undefined,
      expected: 'drive-abc',
    });
  });

  test('stream omitted defaults to true', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-abc', messages };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with stream omitted',
      should: 'default stream to true in the parsed data',
      actual: result.ok ? result.data.stream : undefined,
      expected: true,
    });
  });

  test('plain OpenAI message (no parts) is normalized to UIMessage with parts', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user', content: 'Hello from SDK' }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a plain OpenAI SDK message with string content and no parts',
      should: 'return ok:true with the message normalized to UIMessage format (parts array with text part)',
      actual: result.ok
        ? {
            hasParts: Array.isArray(result.data.messages[0].parts),
            partType: result.data.messages[0].parts[0]?.type,
            partText: result.data.messages[0].parts[0]?.type === 'text'
              ? (result.data.messages[0].parts[0] as { type: 'text'; text: string }).text
              : undefined,
            hasId: typeof result.data.messages[0].id === 'string',
          }
        : undefined,
      expected: { hasParts: true, partType: 'text', partText: 'Hello from SDK', hasId: true },
    });
  });

  test('OpenAI content-array message is normalized to UIMessage with parts', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello array' }] }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an OpenAI SDK message with content as an array of text blocks',
      should: 'return ok:true with parts extracted from the content array',
      actual: result.ok
        ? {
            hasParts: Array.isArray(result.data.messages[0].parts),
            partType: result.data.messages[0].parts[0]?.type,
          }
        : undefined,
      expected: { hasParts: true, partType: 'text' },
    });
  });

  test('null element in messages array returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [null],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a messages array containing a null element',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('message with unrecognized role returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'admin', content: 'Hi' }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a message with a role not in the allowed set (user, assistant, system, tool)',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('message with no content and no parts returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user' }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a message with a valid role but no content and no parts',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('content-array message with no text parts returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user', content: [{ type: 'image', url: 'https://example.com/img.png' }] }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a message whose content array contains only non-text parts (e.g. image)',
      should: 'return ok:false with status 400 because no text content can be extracted',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('conversation_id is extracted and returned as conversationId', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, conversation_id: 'conv-xyz' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with a conversation_id field',
      should: 'include conversationId in the parsed data',
      actual: result.ok ? result.data.conversationId : undefined,
      expected: 'conv-xyz',
    });
  });

  test('whitespace-only conversation_id is treated as absent', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, conversation_id: '   ' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a conversation_id containing only whitespace',
      should: 'return undefined for conversationId',
      actual: result.ok ? result.data.conversationId : 'error',
      expected: undefined,
    });
  });

  test('valid tools array is parsed into clientTools', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const tools = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];
    const body = { model: 'ps-agent://page-123', messages, tools };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a valid tools array with type:function and function.name',
      should: 'return ok:true with clientTools populated',
      actual: result.ok ? result.data.clientTools : undefined,
      expected: [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
    });
  });

  test('tool entry missing function.name returns 400', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, tools: [{ type: 'function', function: { description: 'no name' } }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a tools array with an entry missing function.name',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('tool entry with non-function type returns 400', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, tools: [{ type: 'retrieval', function: { name: 'search' } }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a tools array with an entry whose type is not "function"',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('empty tools array treats clientTools as undefined', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, tools: [] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an empty tools array',
      should: 'return clientTools as undefined',
      actual: result.ok ? result.data.clientTools : 'error',
      expected: undefined,
    });
  });

  test('disable_server_tools:true sets disableServerTools', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, disable_server_tools: true };
    const result = validateInferenceRequest(body);
    assert({
      given: 'disable_server_tools:true in the body',
      should: 'return disableServerTools:true',
      actual: result.ok ? result.data.disableServerTools : undefined,
      expected: true,
    });
  });

  test('disable_server_tools absent defaults to false', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages };
    const result = validateInferenceRequest(body);
    assert({
      given: 'disable_server_tools absent from the body',
      should: 'return disableServerTools:false',
      actual: result.ok ? result.data.disableServerTools : undefined,
      expected: false,
    });
  });

  test('client_manages_history:true sets clientManagesHistory', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, client_manages_history: true };
    const result = validateInferenceRequest(body);
    assert({
      given: 'client_manages_history:true in the body',
      should: 'return clientManagesHistory:true',
      actual: result.ok ? result.data.clientManagesHistory : undefined,
      expected: true,
    });
  });

  test('client_manages_history absent defaults to false', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages };
    const result = validateInferenceRequest(body);
    assert({
      given: 'client_manages_history absent from the body',
      should: 'return clientManagesHistory:false',
      actual: result.ok ? result.data.clientManagesHistory : undefined,
      expected: false,
    });
  });

  test('tool without description or parameters is accepted', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, tools: [{ type: 'function', function: { name: 'read_file' } }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a tool with only name (no description or parameters)',
      should: 'return ok:true with the tool in clientTools',
      actual: result.ok ? result.data.clientTools?.[0]?.function.name : undefined,
      expected: 'read_file',
    });
  });

  test('assistant message with tool_calls (content null) is normalized to tool part', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an assistant message with tool_calls and null content',
      should: 'normalize to a UIMessage with a tool-bash part at input-available state',
      actual: result.ok
        ? { ok: true, partType: (result.data.messages[0].parts[0] as Record<string, unknown>)?.type, partState: (result.data.messages[0].parts[0] as Record<string, unknown>)?.state }
        : { ok: false },
      expected: { ok: true, partType: 'tool-bash', partState: 'input-available' },
    });
  });

  test('assistant tool_calls paired with role:tool result normalized to output-available', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [
        { role: 'user', id: 'msg-1', content: 'run ls', parts: [{ type: 'text', text: 'run ls' }] },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'tc-1', content: 'file1.txt\nfile2.txt' },
      ],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'assistant tool_calls followed by a matching role:tool result',
      should: 'collapse into a single assistant UIMessage with output-available part (not two separate messages)',
      actual: result.ok
        ? {
            messageCount: result.data.messages.length,
            secondRole: result.data.messages[1]?.role,
            partState: (result.data.messages[1]?.parts[0] as Record<string, unknown>)?.state,
            partOutput: (result.data.messages[1]?.parts[0] as Record<string, unknown>)?.output,
          }
        : { ok: false },
      expected: { messageCount: 2, secondRole: 'assistant', partState: 'output-available', partOutput: 'file1.txt\nfile2.txt' },
    });
  });

  test('standalone role:tool message without preceding assistant is skipped', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [
        { role: 'user', id: 'msg-1', content: 'hi', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'tool', tool_call_id: 'orphan', content: 'some result' },
      ],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a role:tool message with no preceding assistant tool_calls',
      should: 'skip it and return ok:true with only the user message',
      actual: result.ok
        ? { ok: true, messageCount: result.data.messages.length }
        : { ok: false },
      expected: { ok: true, messageCount: 1 },
    });
  });

  test('malformed tool_calls entry returns 400 instead of 500', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{}],
      }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an assistant message with a tool_calls entry missing id and function',
      should: 'return ok:false with status 400 (not throw a 500)',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('assistant message with content and tool_calls preserves text as first part', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'assistant',
        content: "I'll run bash for you.",
        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      }],
    };
    const result = validateInferenceRequest(body);
    const parts = result.ok ? result.data.messages[0].parts as Array<Record<string, unknown>> : [];
    assert({
      given: 'an assistant message with both string content and tool_calls',
      should: 'include a text part before the tool part so the natural-language context is preserved',
      actual: result.ok
        ? { ok: true, partCount: parts.length, firstType: parts[0]?.type, firstText: parts[0]?.text, secondType: parts[1]?.type }
        : { ok: false },
      expected: { ok: true, partCount: 2, firstType: 'text', firstText: "I'll run bash for you.", secondType: 'tool-bash' },
    });
  });
});

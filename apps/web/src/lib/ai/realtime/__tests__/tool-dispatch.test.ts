import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import {
  buildVoiceToolContext,
  dispatchRealtimeToolCall,
  formatToolResult,
  parseToolArguments,
  type RealtimeToolDispatchDeps,
  type RealtimeToolDispatchRequest,
} from '../tool-dispatch';
import type { ToolExecutionContext } from '../../core/types';
import { buildRealtimeToolExposure } from '../tools';
import { buildPageSpaceTools } from '../../core/ai-tools';

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

const request = (
  over: Partial<RealtimeToolDispatchRequest> = {},
): RealtimeToolDispatchRequest => ({
  name: 'read_page',
  argumentsJson: '{"pageId":"p1"}',
  userId: 'u1',
  callId: 'rtc_1',
  ...over,
});

/** A tool whose execute records the options bag it was handed. */
const spyTool = (execute: (args: unknown, options: unknown) => unknown): Tool =>
  ({
    description: 'Read a page.',
    inputSchema: z.object({ pageId: z.string() }),
    execute,
  }) as unknown as Tool;

const deps = (tools: ToolSet): RealtimeToolDispatchDeps => ({ tools, logger: logger() });

describe('parseToolArguments', () => {
  it('given a newline-laden JSON string, should parse it', () => {
    expect(parseToolArguments('{\n  "pageId": "p1",\n  "lines": 20\n}')).toEqual({
      ok: true,
      args: { pageId: 'p1', lines: 20 },
    });
  });

  it('given an absent or blank argument string, should read it as a no-argument call', () => {
    expect(parseToolArguments('')).toEqual({ ok: true, args: {} });
    expect(parseToolArguments('   \n ')).toEqual({ ok: true, args: {} });
  });

  it('given trailing junk after a complete object, should recover the object', () => {
    // The string is assembled from streamed deltas; a double-appended payload is
    // rare but real, and the common corruption is recoverable.
    expect(parseToolArguments('{"pageId":"p1"}{"pageId":"p2"}')).toEqual({
      ok: true,
      args: { pageId: 'p1' },
    });
  });

  it('given a nested object with trailing junk, should count braces rather than regex them', () => {
    expect(parseToolArguments('{"a":{"b":{"c":1}}} trailing')).toEqual({
      ok: true,
      args: { a: { b: { c: 1 } } },
    });
  });

  it('given braces inside a string value, should not mistake them for structure', () => {
    expect(parseToolArguments('{"q":"a } b"} junk')).toEqual({
      ok: true,
      args: { q: 'a } b' },
    });
  });

  it('given an escaped quote inside a string, should keep tracking the string correctly', () => {
    expect(parseToolArguments('{"q":"say \\"} \\" now"} junk')).toEqual({
      ok: true,
      args: { q: 'say "} " now' },
    });
  });

  it('given a truncated object, should report something the model can say', () => {
    const parsed = parseToolArguments('{"pageId": "p1"');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('could not be read');
  });

  it('given no object at all, should report rather than throw', () => {
    expect(parseToolArguments('not json at all').ok).toBe(false);
  });

  it('given a valid JSON value that is not an object, should refuse it', () => {
    // `null`, an array and a bare number all parse; none is an argument bag.
    expect(parseToolArguments('null').ok).toBe(false);
    expect(parseToolArguments('[1,2]').ok).toBe(false);
    expect(parseToolArguments('42').ok).toBe(false);
  });

  it('given a recovered fragment that is still not an object, should refuse it', () => {
    expect(parseToolArguments('oops {"a":1} but also {').ok).toBe(true);
    expect(parseToolArguments('[{]').ok).toBe(false);
  });
});

describe('formatToolResult', () => {
  it('given a string result, should speak it as-is', () => {
    expect(formatToolResult('Two pages.')).toBe('Two pages.');
  });

  it('given a structured result, should serialize it', () => {
    expect(formatToolResult({ count: 2 })).toBe('{"count":2}');
  });

  it('given an empty or absent result, should still say something', () => {
    expect(formatToolResult('')).toBe('Done.');
    expect(formatToolResult(undefined)).toBe('Done.');
    expect(formatToolResult(null)).toBe('Done.');
  });

  it('given a LONG result, should hand the model all of it', () => {
    // This used to be cut at 700 characters on the reasoning that a spoken
    // answer cannot be skimmed — which is a rule about what the model says, not
    // about what it is allowed to know. The typed surface caps nothing, and
    // this is the same agent.
    const long = 'alpha beta '.repeat(500);

    expect(formatToolResult(long)).toBe(long.trim());
  });

  it('should never invent a continuation hint about content it did not drop', () => {
    expect(formatToolResult('x'.repeat(5000))).toBe('x'.repeat(5000));
    expect(formatToolResult('alpha beta '.repeat(500))).not.toContain('were not read out');
  });

  it('given a circular structure, should not throw', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatToolResult(circular)).not.toThrow();
  });

  it('given a value JSON.stringify drops, should fall back to a string', () => {
    expect(formatToolResult(() => 1)).not.toBe('');
  });

  it('should hand back a tool_search result the model can actually parse', async () => {
    // THE FAILURE THIS EXISTS FOR. `tool_search` answers with JSON Schemas, and
    // a keyword like "calendar" matches enough tools to run to several thousand
    // characters. Cut to 700 it arrived sliced mid-object, so the model could
    // not build the `execute_tool` call it went looking for — it guessed
    // parameters, failed validation, and tried again. That loop is what "it
    // doesn't navigate tool calls" looked like from the outside.
    const search = buildRealtimeToolExposure(buildPageSpaceTools()).tools.tool_search;
    const raw = await (search.execute as (a: unknown, o: unknown) => unknown)(
      { query: 'calendar' },
      { experimental_context: {}, toolCallId: 't1', messages: [] },
    );

    const spoken = formatToolResult(raw);

    expect(spoken.length).toBeGreaterThan(2000);
    const parsed = JSON.parse(spoken) as { tools: { name: string; inputSchema: unknown }[] };
    expect(parsed.tools.length).toBeGreaterThan(1);
    // A schema is only useful whole: every matched tool has to arrive with the
    // parameters the model is about to fill in.
    for (const tool of parsed.tools) {
      expect(tool.inputSchema, `${tool.name} arrived without its schema`).toBeTruthy();
    }
  });
});

describe('buildVoiceToolContext', () => {
  it('should carry the acting user, the conversation, the timezone and the location', () => {
    const context = buildVoiceToolContext(
      request({
        conversationId: 'conv1',
        timezone: 'America/New_York',
        locationContext: { currentPage: { id: 'p1', title: 'N', type: 'DOCUMENT', path: '/n' } },
      }),
      'gpt-realtime-2.1',
    );

    expect(context).toMatchObject({
      userId: 'u1',
      conversationId: 'conv1',
      timezone: 'America/New_York',
      locationContext: { currentPage: { id: 'p1' } },
      aiProvider: 'openai_voice',
      aiModel: 'gpt-realtime-2.1',
    });
  });

  it('should mark the turn as a user request at depth zero, not a sub-agent run', () => {
    const context = buildVoiceToolContext(request(), 'gpt-realtime-2.1');
    expect(context.requestOrigin).toBe('user');
    expect(context.agentCallDepth).toBe(0);
  });

  it('given no conversation, timezone or location, should omit them rather than send undefined', () => {
    const context = buildVoiceToolContext(request(), 'gpt-realtime-2.1');
    expect('conversationId' in context).toBe(false);
    expect('timezone' in context).toBe(false);
    expect('locationContext' in context).toBe(false);
  });

  it('given a bound page agent, should name it as the ACTOR the tools authorize as', () => {
    // `resolveActingAgentId` reads chatSource.agentPageId, and every canActor*
    // check falls through to the invoking user's own reach without it — so an
    // agent with a narrower ACL silently borrowed the caller's.
    const context = buildVoiceToolContext(
      request({
        assistant: {
          agentPageId: 'agent1',
          agentTitle: 'Release Notes Bot',
          enabledTools: ['read_page'],
        },
      }),
      'gpt-realtime-2.1',
    );

    expect(context.chatSource).toEqual({
      type: 'page',
      agentPageId: 'agent1',
      agentTitle: 'Release Notes Bot',
    });
  });

  it("given a bound agent's allowlist, should carry it so execute_tool re-checks against it", () => {
    // execute_tool reads `enabledTools` off this context and treats undefined
    // as unrestricted, which re-opened exactly the tools the owner switched off.
    const context = buildVoiceToolContext(
      request({
        assistant: { agentPageId: 'agent1', agentTitle: 'Bot', enabledTools: ['read_page'] },
      }),
      'gpt-realtime-2.1',
    );

    expect(context.enabledTools).toEqual(['read_page']);
  });

  it('given an agent with an EMPTY allowlist, should carry [] rather than drop the field', () => {
    // Dropping it would read as unrestricted — the opposite of what [] means.
    const context = buildVoiceToolContext(
      request({ assistant: { agentPageId: 'agent1', agentTitle: 'Bot', enabledTools: [] } }),
      'gpt-realtime-2.1',
    );

    expect(context.enabledTools).toEqual([]);
  });

  it('given NO bound agent, should act as the user rather than invent an agent', () => {
    // The Global Assistant and an unbound call have no agent page; falling
    // through to the authenticated user is the honest actor.
    const context = buildVoiceToolContext(request(), 'gpt-realtime-2.1');

    expect('chatSource' in context).toBe(false);
    expect('enabledTools' in context).toBe(false);
  });
});

describe('dispatchRealtimeToolCall', () => {
  it('given a real tool, should run it and return its formatted result', async () => {
    const execute = vi.fn(async () => ({ title: 'Notes' }));
    const output = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(execute) }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(execute).toHaveBeenCalled();
    expect(output).toBe('{"title":"Notes"}');
  });

  it('should hand the tool a ToolExecutionContext carrying the REAL acting user', async () => {
    // The single security-relevant thing this module does: every PageSpace tool
    // enforces access internally against the userId on this context.
    let seen: ToolExecutionContext | undefined;
    await dispatchRealtimeToolCall(
      deps({
        read_page: spyTool((_args, options) => {
          seen = (options as { experimental_context: ToolExecutionContext }).experimental_context;
          return 'ok';
        }),
      }),
      request({ userId: 'the-real-user', conversationId: 'conv1' }),
      'gpt-realtime-2.1',
    );

    expect(seen?.userId).toBe('the-real-user');
    expect(seen?.conversationId).toBe('conv1');
  });

  it('should pass the options bag under experimental_context, as the tools read it', async () => {
    let options: unknown;
    await dispatchRealtimeToolCall(
      deps({
        read_page: spyTool((_args, opts) => {
          options = opts;
          return 'ok';
        }),
      }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(options).toMatchObject({ toolCallId: 'rtc_1', messages: [] });
    expect((options as { experimental_context?: unknown }).experimental_context).toBeDefined();
  });

  it('given a tool name that was never advertised, should tell the model how to recover', async () => {
    const output = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(() => 'ok') }),
      request({ name: 'delete_everything' }),
      'gpt-realtime-2.1',
    );

    expect(output).toContain('no tool called "delete_everything"');
    expect(output).toContain('tool_search');
  });

  it('given a tool with no implementation, should say so rather than hang', async () => {
    const output = await dispatchRealtimeToolCall(
      deps({
        read_page: { description: 'x', inputSchema: z.object({}) } as unknown as Tool,
      }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(output).toContain('cannot be run');
  });

  it('given unreadable arguments, should answer with a sentence rather than run the tool', async () => {
    const execute = vi.fn();
    const output = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(execute) }),
      request({ argumentsJson: '{"pageId": ' }),
      'gpt-realtime-2.1',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(output).toContain('could not be read');
  });

  it('given arguments the tool schema rejects, should report the schema, not run the tool', async () => {
    const execute = vi.fn();
    const output = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(execute) }),
      request({ argumentsJson: '{"pageId": 42}' }),
      'gpt-realtime-2.1',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(output).toContain('Invalid parameters');
    expect(output).toContain('select:read_page');
  });

  it('given the tool validates the arguments, should pass the PARSED value through', async () => {
    let received: unknown;
    await dispatchRealtimeToolCall(
      deps({
        read_page: spyTool((args) => {
          received = args;
          return 'ok';
        }),
      }),
      request({ argumentsJson: '{"pageId":"p1","extra":"dropped"}' }),
      'gpt-realtime-2.1',
    );

    expect(received).toEqual({ pageId: 'p1' });
  });

  it('given a throwing tool (a permission refusal), should turn it into something speakable', async () => {
    const output = await dispatchRealtimeToolCall(
      deps({
        read_page: spyTool(() => {
          throw new Error("You don't have access to that page");
        }),
      }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(output).toContain("You don't have access to that page");
  });

  it('given a tool that throws a non-Error, should still answer', async () => {
    const output = await dispatchRealtimeToolCall(
      deps({
        read_page: spyTool(() => {
          throw 'nope';
        }),
      }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(output).toContain('nope');
  });

  it('given a huge tool result, should return the whole thing', async () => {
    // A page read is the case that matters: 700 characters of a document is
    // neither a summary the model can give nor enough to edit from, because
    // `replace_lines` works off line numbers in a full read.
    const page = 'word '.repeat(5000);
    const output = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(() => page) }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(output).toBe(page.trim());
  });

  it('should ALWAYS return a string — function_call_output cannot carry anything else', async () => {
    const cases = [
      dispatchRealtimeToolCall(deps({}), request(), 'gpt-realtime-2.1'),
      dispatchRealtimeToolCall(
        deps({ read_page: spyTool(() => undefined) }),
        request(),
        'gpt-realtime-2.1',
      ),
      dispatchRealtimeToolCall(
        deps({ read_page: spyTool(() => ({ nested: { deep: true } })) }),
        request(),
        'gpt-realtime-2.1',
      ),
    ];

    for (const output of await Promise.all(cases)) {
      expect(typeof output).toBe('string');
    }
  });
});

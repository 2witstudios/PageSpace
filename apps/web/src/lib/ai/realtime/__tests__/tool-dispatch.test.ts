import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import {
  buildVoiceToolContext,
  dispatchRealtimeToolCall,
  formatToolResult,
  MAX_SPOKEN_RESULT_CHARS,
  parseToolArguments,
  type RealtimeToolDispatchDeps,
  type RealtimeToolDispatchRequest,
} from '../tool-dispatch';
import type { ToolExecutionContext } from '../../core/types';

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

  it('given a long result, should cut at a word boundary and say how much was left', () => {
    const long = 'alpha beta '.repeat(500);
    const spoken = formatToolResult(long);

    expect(spoken.length).toBeLessThan(long.length);
    expect(spoken).toContain('more characters were not read out');
    // Never a severed word.
    expect(spoken.split('…')[0].endsWith('beta') || spoken.split('…')[0].endsWith('alpha')).toBe(true);
  });

  it('given a long result with no spaces, should still cut it', () => {
    const spoken = formatToolResult('x'.repeat(5000));
    expect(spoken.length).toBeLessThan(5000);
  });

  it('given a result exactly at the cap, should not truncate', () => {
    const exact = 'y'.repeat(MAX_SPOKEN_RESULT_CHARS);
    expect(formatToolResult(exact)).toBe(exact);
  });

  it('given a circular structure, should not throw', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatToolResult(circular)).not.toThrow();
  });

  it('given a value JSON.stringify drops, should fall back to a string', () => {
    expect(formatToolResult(() => 1)).not.toBe('');
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

  it('given a huge tool result, should truncate before returning it', async () => {
    const output = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(() => 'word '.repeat(5000)) }),
      request(),
      'gpt-realtime-2.1',
    );

    expect(output.length).toBeLessThan(1000);
    expect(output).toContain('were not read out');
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

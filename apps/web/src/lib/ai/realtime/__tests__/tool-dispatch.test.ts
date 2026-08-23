import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import {
  buildVoiceToolContext,
  dispatchRealtimeToolCall,
  formatToolResult,
  MAX_RESULT_CHARS,
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
    // about what it is allowed to know. 5,500 characters is far past the old
    // ceiling and nowhere near the session's.
    const long = 'alpha beta '.repeat(500);

    expect(formatToolResult(long)).toBe(long.trim());
  });

  it('should never invent a continuation hint about content it did not drop', () => {
    expect(formatToolResult('x'.repeat(5000))).toBe('x'.repeat(5000));
    expect(formatToolResult('alpha beta '.repeat(500))).not.toContain('were not returned');
  });

  it('given a result that would not FIT in the session, should cut it and say how to ask again', () => {
    // A realtime session is 32k tokens shared with the audio, and a
    // `function_call_output` stays in it — so one result can end a call. Not a
    // speech rule: the model summarises for the listener either way.
    const huge = 'word '.repeat(6000);

    const spoken = formatToolResult(huge);

    expect(spoken.length).toBeLessThan(MAX_RESULT_CHARS + 400);
    expect(spoken).toContain('characters were not returned');
    // Leads with the general instruction, because a truncated listing or
    // search is the common case and neither specific escape fits it.
    expect(spoken).toContain('Ask again for less');
    expect(spoken).toContain('tool_search("select:name")');
    expect(spoken).toContain('lineStart/lineEnd');
  });

  it('should cut at a word boundary rather than mid-token', () => {
    const spoken = formatToolResult('alpha beta '.repeat(3000));
    expect(spoken.split('…')[0].endsWith('alpha') || spoken.split('…')[0].endsWith('beta')).toBe(true);
  });

  it('given a circular structure, should not throw', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatToolResult(circular)).not.toThrow();
  });

  it('given a value JSON.stringify drops, should fall back to a string', () => {
    expect(formatToolResult(() => 1)).not.toBe('');
  });

  it('should hand back a schema lookup the model can actually parse', async () => {
    // THE FAILURE THIS EXISTS FOR. `tool_search` answers with JSON Schemas, and
    // at 700 characters they arrived sliced mid-object — so the model could not
    // build the `execute_tool` call it went looking for. It guessed parameters,
    // failed validation, and tried again. That loop is what "it doesn't
    // navigate tool calls" looked like from the outside.
    //
    // `select:` is the lookup `TOOL_DISCOVERY_PROMPT` actually instructs before
    // calling a tool, so it is the path that has to survive whole. Measured at
    // ~7k characters for two tools, comfortably inside the ceiling.
    const search = buildRealtimeToolExposure(buildPageSpaceTools()).tools.tool_search;
    const raw = await (search.execute as (a: unknown, o: unknown) => unknown)(
      { query: 'select:create_task,update_task' },
      { experimental_context: {}, toolCallId: 't1', messages: [] },
    );

    const spoken = formatToolResult(raw);

    expect(spoken).not.toContain('were not returned');
    const parsed = JSON.parse(spoken) as { tools: { name: string; inputSchema: unknown }[] };
    expect(parsed.tools).toHaveLength(2);
    // A schema is only useful whole: every matched tool has to arrive with the
    // parameters the model is about to fill in.
    for (const tool of parsed.tools) {
      expect(tool.inputSchema, `${tool.name} arrived without its schema`).toBeTruthy();
    }
  });

  it('given a BROAD search, should cut it rather than let it end the call', async () => {
    // Measured: a one-letter query returns ~89k characters, which is ~22k
    // tokens — most of the session, spent on a dump the model did not need in
    // full. It is told to ask again by name.
    const search = buildRealtimeToolExposure(buildPageSpaceTools()).tools.tool_search;
    const raw = await (search.execute as (a: unknown, o: unknown) => unknown)(
      { query: 'a' },
      { experimental_context: {}, toolCallId: 't1', messages: [] },
    );

    const spoken = formatToolResult(raw);

    expect(JSON.stringify(raw).length).toBeGreaterThan(50_000);
    expect(spoken.length).toBeLessThan(MAX_RESULT_CHARS + 400);
    expect(spoken).toContain('Ask again for less');
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
    const { output } = await dispatchRealtimeToolCall(
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
    const { output } = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(() => 'ok') }),
      request({ name: 'delete_everything' }),
      'gpt-realtime-2.1',
    );

    expect(output).toContain('no tool called "delete_everything"');
    expect(output).toContain('tool_search');
  });

  it('given a near-miss tool name, should name one the session ACTUALLY advertised', async () => {
    // Built from the real exposure, not a hand-made map. A voice session
    // advertises only the core tools plus tool_search/execute_tool — every
    // sandbox tool is deferred behind execute_tool — so a test that injects
    // `readFile` here proves nothing about production: the dispatcher could
    // never be handed that name in the first place. The near miss that IS
    // reachable is one against a core tool.
    const advertised = buildRealtimeToolExposure(buildPageSpaceTools()).tools;
    expect(Object.keys(advertised)).toContain('read_page');
    expect(Object.keys(advertised)).not.toContain('readFile');

    const { output } = await dispatchRealtimeToolCall(
      deps(advertised),
      request({ name: 'read_pages' }),
      'gpt-realtime-2.1',
    );

    expect(output).toContain('Did you mean: read_page');
  });

  it('given a deferred tool name spoken directly, should not invent a suggestion it cannot run', async () => {
    // `readFile` is real, but it lives behind execute_tool — suggesting it here
    // would send the model to a name this dispatcher cannot execute. The
    // discovery prompt already routes non-core tools through execute_tool, and
    // that path (createExecuteTool) is where the readFile suggestion belongs.
    const advertised = buildRealtimeToolExposure(buildPageSpaceTools()).tools;

    const { output } = await dispatchRealtimeToolCall(
      deps(advertised),
      request({ name: 'readFile' }),
      'gpt-realtime-2.1',
    );

    expect(output).toContain('no tool called "readFile"');
    expect(output).not.toContain('Did you mean');
    expect(output).toContain('tool_search');
  });

  it('given a tool with no implementation, should say so rather than hang', async () => {
    const { output } = await dispatchRealtimeToolCall(
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
    const { output } = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(execute) }),
      request({ argumentsJson: '{"pageId": ' }),
      'gpt-realtime-2.1',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(output).toContain('could not be read');
  });

  it('given arguments the tool schema rejects, should report the schema, not run the tool', async () => {
    const execute = vi.fn();
    const { output } = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(execute) }),
      request({ argumentsJson: '{"pageId": 42}' }),
      'gpt-realtime-2.1',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(output).toContain('Invalid parameters');
    // The schema itself, not a pointer to `tool_search` — a voice session has
    // 32k tokens for the whole call, so a wasted discovery round trip is
    // expensive here in a way it is not on the text stack.
    // Read off the SCHEMA section, not the whole string: the zod message names
    // the offending key as well, so searching the whole output would pass even
    // with the schema gone.
    const marker = 'Input schema for "read_page": ';
    const schemaSection = output.slice(output.indexOf(marker) + marker.length);
    expect(JSON.parse(schemaSection)).toMatchObject({
      properties: { pageId: { type: 'string' } },
      required: ['pageId'],
    });
    expect(output).not.toContain('select:read_page');
  });

  it('given a rejected call on a real tool, should stay far inside the result ceiling', async () => {
    const { output } = await dispatchRealtimeToolCall(
      deps(buildPageSpaceTools()),
      request({ name: 'create_calendar_event', argumentsJson: '{}' }),
      'gpt-realtime-2.1',
    );

    // Measured against the largest schema in the product, not a synthetic one.
    const marker = 'Input schema for "create_calendar_event": ';
    expect(output).toContain(marker);
    expect(
      Object.keys(
        (JSON.parse(output.slice(output.indexOf(marker) + marker.length)) as {
          properties: Record<string, unknown>;
        }).properties,
      ).length,
    ).toBeGreaterThan(3);
    expect(output.length).toBeLessThan(MAX_RESULT_CHARS);
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
    const { output } = await dispatchRealtimeToolCall(
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
    const { output } = await dispatchRealtimeToolCall(
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

    for (const { output } of await Promise.all(cases)) {
      expect(typeof output).toBe('string');
    }
  });

  it('should say whether the TOOL failed, not just whether the hop did', async () => {
    // Every failure below still returns a speakable sentence, because the model
    // is blocked on `function_call_output` until it gets one. That is exactly
    // why a second answer is needed: without it, a permission error is written
    // into the thread as a completed tool call, rendered green.
    const failing = [
      // Unadvertised tool.
      dispatchRealtimeToolCall(deps({}), request(), 'gpt-realtime-2.1'),
      // No implementation.
      dispatchRealtimeToolCall(
        deps({ read_page: { description: 'x', inputSchema: z.object({}) } as Tool }),
        request(),
        'gpt-realtime-2.1',
      ),
      // Unreadable arguments.
      dispatchRealtimeToolCall(
        deps({ read_page: spyTool(() => 'ok') }),
        request({ argumentsJson: 'not json' }),
        'gpt-realtime-2.1',
      ),
      // Arguments the schema refuses.
      dispatchRealtimeToolCall(
        deps({ read_page: spyTool(() => 'ok') }),
        request({ argumentsJson: '{"pageId":42}' }),
        'gpt-realtime-2.1',
      ),
      // A tool that threw.
      dispatchRealtimeToolCall(
        deps({
          read_page: spyTool(() => {
            throw new Error('permission denied');
          }),
        }),
        request(),
        'gpt-realtime-2.1',
      ),
    ];

    for (const outcome of await Promise.all(failing)) {
      expect(outcome.failed, outcome.output).toBe(true);
      // Still speakable: the model must never be left waiting.
      expect(outcome.output.length).toBeGreaterThan(0);
    }

    const worked = await dispatchRealtimeToolCall(
      deps({ read_page: spyTool(() => 'Two pages.') }),
      request(),
      'gpt-realtime-2.1',
    );
    expect(worked).toEqual({ output: 'Two pages.', failed: false });
  });
});

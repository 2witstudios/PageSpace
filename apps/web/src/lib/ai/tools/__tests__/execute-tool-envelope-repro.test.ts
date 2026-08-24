/**
 * Reproduction for issue #2461 — "Worker session execute_tool calls fail
 * (tool_name stripped from envelope) after sustained high-volume tool use".
 *
 * The reporter's phrase "stripped from the envelope" describes the symptom, not
 * the mechanism. There is no parent→worker envelope carrying `tool_name` at all:
 * spawn_session/send_session ship only a signed `{ text }`, and the worker runs
 * its own model loop. So the failing `tool_name` is emitted by the WORKER'S OWN
 * provider and validated by the AI SDK against createExecuteTool's inputSchema.
 *
 * These tests pin down which provider behaviour produces the reported error
 * verbatim, and which one does not — that discrimination is what separates
 * diagnosis from speculation.
 */
import { describe, it } from 'vitest';
import { z } from 'zod';
import { streamText, stepCountIs, asSchema, type Tool, type ToolSet } from 'ai';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { assert } from './riteway';
import { createExecuteTool } from '../execute-tool';
import { capStepToolPayloads } from '@/lib/ai/core/cap-step-tool-payloads';

// Derived from the mock's own signature rather than imported from
// @ai-sdk/provider, which apps/web does not depend on directly — it is only
// present transitively, so tsc cannot resolve it even though vitest can.
type DoStream = MockLanguageModelV3['doStream'];
type StreamPart =
  Awaited<ReturnType<DoStream>>['stream'] extends ReadableStream<infer Part> ? Part : never;

/** Stand-in for the reporter's real payload sink (edit_sheet_cells, ~240 cells/call). */
const editSheetCells: Tool = {
  description: 'Apply cell edits to a sheet',
  inputSchema: z.object({ pageId: z.string(), cells: z.array(z.unknown()) }),
  execute: async () => ({ ok: true }),
};

/** Stand-in for the reporter's other half: tiny arguments, a very large result. */
const readFileTool: Tool = {
  description: 'Read a file',
  inputSchema: z.object({ path: z.string() }),
  execute: async () => ({ content: 'z'.repeat(100_000) }),
};

const registry: ToolSet = { edit_sheet_cells: editSheetCells, readFile: readFileTool };

/**
 * A single provider turn that emits one `execute_tool` call whose raw argument
 * string is exactly `inputText`. An empty string models the case where the
 * response was cut off after the tool-use block opened but before any argument
 * token was produced.
 */
function providerEmitting(nextInput: () => string): DoStream {
  let callCount = 0;
  return async () => {
    const inputText = nextInput();
    callCount += 1;
    const id = `call-${callCount}`;
    return {
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({
            type: 'response-metadata',
            id: `resp-${callCount}`,
            modelId: 'mock',
            timestamp: new Date(0),
          });
          controller.enqueue({ type: 'tool-input-start', id, toolName: 'execute_tool' });
          if (inputText !== '') {
            controller.enqueue({ type: 'tool-input-delta', id, delta: inputText });
          }
          controller.enqueue({ type: 'tool-input-end', id });
          controller.enqueue({
            type: 'tool-call',
            toolCallId: id,
            toolName: 'execute_tool',
            input: inputText,
          });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    };
  };
}

/** Drive one real streamText step and return the error text the model is handed back. */
async function toolErrorTextFor(inputText: string): Promise<string> {
  const result = streamText({
    model: new MockLanguageModelV3({ doStream: providerEmitting(() => inputText) }),
    messages: [{ role: 'user', content: 'apply the next chunk' }],
    tools: { execute_tool: createExecuteTool(registry) },
    stopWhen: [stepCountIs(1)],
  });
  for await (const _part of result.fullStream) {
    void _part;
  }
  const content = await result.content;
  const toolError = content.find((part) => part.type === 'tool-error');
  return toolError && 'error' in toolError ? String(toolError.error) : '';
}

describe('issue #2461 — execute_tool "tool_name" validation failure', () => {
  it('an empty argument string reproduces the reported failure', async () => {
    const errorText = await toolErrorTextFor('');

    // The reported error:
    //   Invalid input for tool execute_tool: Type validation failed.
    //   Error: [{ "expected": "string", "code": "invalid_type",
    //             "path": ["tool_name"],
    //             "message": "Invalid input: expected string, received undefined" }]
    //
    // Everything asserted here is the MECHANISM, which is permanent: an
    // argument-less provider response fails type validation, at path tool_name,
    // for this tool. The stock zod sentence quoted on the last line above is the
    // one part the fix deliberately replaces — that wording is what made the
    // failure unactionable — so it is pinned in the fix test below, not here.
    assert({
      given: 'a provider that emits execute_tool with no argument tokens at all',
      should: 'fail type validation at tool_name, exactly as reported in #2461',
      actual: {
        namesTheTool: errorText.includes('Invalid input for tool execute_tool'),
        typeValidation: errorText.includes('Type validation failed'),
        blamesToolName: errorText.includes('"path"') && errorText.includes('tool_name'),
      },
      expected: {
        namesTheTool: true,
        typeValidation: true,
        blamesToolName: true,
      },
    });
  });

  it('the empty call is validated as {} — nothing ever stripped a field', async () => {
    const errorText = await toolErrorTextFor('');

    // `Value: {}` is the tell. The AI SDK coerces an empty argument string to an
    // empty object before validating (parseToolCall → doParseToolCall:
    // `toolCall.input.trim() === '' ? safeValidateTypes({ value: {}, schema })`),
    // so zod reports the REQUIRED `tool_name` as missing. The model never sent a
    // tool_name for anything to strip — it sent no arguments whatsoever.
    assert({
      given: 'the empty-argument call that reproduces #2461',
      should: 'show the SDK validated an empty object, not a field-stripped envelope',
      actual: errorText.includes('Value: {}'),
      expected: true,
    });
  });

  it('a payload truncated MID-argument fails differently — ruling that cause out', async () => {
    // Several-hundred-KB payloads make "the arguments were cut off half-written"
    // the obvious suspect. It produces a JSON parse error, NOT the reported type
    // validation error, so the reporter's failure is specifically the case where
    // ZERO argument tokens were emitted.
    const errorText = await toolErrorTextFor(
      '{"tool_name":"edit_sheet_cells","parameters":{"pageId":"p1","cel'
    );

    assert({
      given: 'a provider whose execute_tool arguments are cut off mid-JSON',
      should: 'fail as a JSON parse error, not as the reported tool_name type error',
      actual: {
        jsonParseFailure: errorText.includes('JSON parsing failed'),
        reportedTypeFailure: errorText.includes('Type validation failed'),
      },
      expected: { jsonParseFailure: true, reportedTypeFailure: false },
    });
  });

  it('a well-formed call still succeeds — the payload shape is not the trigger', async () => {
    // The reporter noted earlier identical calls in the same session had worked.
    // Confirm the schema accepts the shape, so nothing about the call itself is
    // at fault: the same envelope succeeds whenever the arguments actually arrive.
    const errorText = await toolErrorTextFor(
      JSON.stringify({
        tool_name: 'edit_sheet_cells',
        parameters: { pageId: 'p1', cells: [{ row: 1, col: 1, value: 'x' }] },
      })
    );

    assert({
      given: 'a fully-formed execute_tool call with the same envelope shape',
      should: 'produce no tool error at all',
      actual: errorText,
      expected: '',
    });
  });
});

describe('issue #2461 — the fixes', () => {
  it('the no-arguments failure now names the real cause instead of blaming tool_name', async () => {
    const errorText = await toolErrorTextFor('');

    // Same provider behaviour as the reproduction above. What changed is what the
    // model is told: "you forgot a field" (unactionable — it did not) becomes a
    // named cause and a recovery it can actually perform.
    assert({
      given: 'the empty-argument call that wedged the reporter\'s worker',
      should: 'tell the model its output was cut off and to send a smaller payload',
      actual: {
        namesTruncation: errorText.includes('the response was cut off before the arguments finished'),
        saysRetryIsFutile: errorText.includes('retrying unchanged would fail the same way'),
        givesTheRecovery: errorText.includes('re-send with fewer items per call'),
      },
      expected: {
        namesTruncation: true,
        saysRetryIsFutile: true,
        givesTheRecovery: true,
      },
    });
  });

  it('stays accurate when the arguments DID arrive but tool_name was omitted', async () => {
    // A field-level zod issue sees only the value at its own path, so `{}` and
    // `{"parameters": {...}}` both surface as `tool_name: undefined`. The message
    // must therefore not assert that nothing arrived — a model that merely left
    // the key out would go off shrinking a payload that was never the problem.
    const errorText = await toolErrorTextFor(
      JSON.stringify({ parameters: { pageId: 'p1', cells: [] } })
    );

    assert({
      given: 'a call carrying a valid parameters object but no tool_name',
      should: 'offer the omitted-field recovery without claiming the call was empty',
      actual: {
        offersTheFieldFix: errorText.includes('re-send the same call with tool_name set'),
        claimsNothingArrived: errorText.includes('carried no arguments at all'),
      },
      expected: { offersTheFieldFix: true, claimsNothingArrived: false },
    });
  });

  it('a genuinely wrong-typed tool_name still gets its own plain message', async () => {
    // The truncation wording must not swallow the ordinary mistake it sits next to.
    const errorText = await toolErrorTextFor(JSON.stringify({ tool_name: 42, parameters: {} }));

    assert({
      given: 'a tool_name that arrived but is not a string',
      should: 'report the type, not the truncation story',
      actual: {
        namesTheType: errorText.includes('tool_name must be a string (received number)'),
        borrowsTruncationWording: errorText.includes('cut off before the arguments'),
      },
      expected: { namesTheType: true, borrowsTruncationWording: false },
    });
  });

  it('the friendlier error did not change the tool contract the provider is sent', async () => {
    // The fix rewrites zod's MESSAGE, which must stay invisible to the provider:
    // if `required` or the property types drifted, models would start omitting
    // tool_name for real and the fix would have manufactured the bug it explains.
    const schema = await asSchema(
      createExecuteTool(registry).inputSchema as Parameters<typeof asSchema>[0]
    ).jsonSchema;

    assert({
      given: 'the execute_tool input schema as the provider receives it',
      should: 'still require tool_name as a plain string',
      actual: {
        required: (schema as { required?: string[] }).required,
        toolName: (schema as { properties?: Record<string, unknown> }).properties?.tool_name,
      },
      expected: {
        required: ['tool_name'],
        toolName: { type: 'string' },
      },
    });
  });

  it('the per-step cap bounds a READ-heavy loop too, not just a write-heavy one', async () => {
    // The reporter's agent did both: readFile a JSON chunk (a ~100 KB RESULT),
    // then edit_sheet_cells it (a ~100 KB ARGUMENT). Capping only arguments left
    // results accumulating at the same dead-linear +100 KB per step, so #2461
    // stayed reproducible for anything read-heavy. Both directions are capped.
    //
    // Run the identical loop twice — once capped, once not — so the assertion is
    // a measured difference between them rather than a threshold picked to pass.
    const STEPS = 8;

    async function lastStepGrowth(capped: boolean): Promise<number> {
      let step = 0;
      const model = new MockLanguageModelV3({
        doStream: providerEmitting(() => {
          step += 1;
          return JSON.stringify({
            tool_name: 'readFile',
            parameters: { path: `chunk-${step}.json` },
          });
        }),
      });
      const result = streamText({
        model,
        messages: [{ role: 'user', content: 'read every chunk' }],
        tools: { execute_tool: createExecuteTool(registry) },
        stopWhen: [stepCountIs(STEPS)],
        ...(capped
          ? {
              prepareStep: ({ messages: m }: { messages: ModelMessage[] }) => ({
                messages: capStepToolPayloads(m),
              }),
            }
          : {}),
      });
      for await (const _part of result.fullStream) {
        void _part;
      }
      await result.content;
      const bytes = model.doStreamCalls.map((call) => JSON.stringify(call.prompt).length);
      return bytes[STEPS - 1] - bytes[STEPS - 2];
    }

    const uncappedGrowth = await lastStepGrowth(false);
    const cappedGrowth = await lastStepGrowth(true);

    assert({
      given: `${STEPS} sequential 100 KB reads in one agent loop`,
      should: 'still grow by a whole result uncapped, and by almost nothing capped',
      actual: {
        uncappedGrowsByAWholeResult: uncappedGrowth > 90_000,
        cappedGrowthIsTiny: cappedGrowth < uncappedGrowth / 50,
      },
      expected: { uncappedGrowsByAWholeResult: true, cappedGrowthIsTiny: true },
    });
  });

  it("reproduces the reporter's own workflow, and bounds it", async () => {
    // The closest thing to "does this fix #2461?". The reporter's agent
    // ALTERNATED: readFile a JSON chunk (a several-hundred-KB result), then
    // edit_sheet_cells it (a several-hundred-KB argument), ~30 times. The tests
    // above drive each direction on its own; this drives the real mixture.
    //
    // Uncapped, the transcript crosses ~1.1 MB by step 5 — past a 200k-token
    // window — which is exactly where the reporter stopped: "first ~4 files
    // applied fine, after that EVERY subsequent call failed."
    const chunk = 'z'.repeat(300_000);
    const cells = Array.from({ length: 240 }, (_, i) => ({ row: i, col: 1, value: 'x'.repeat(1200) }));
    const mixedRegistry: ToolSet = {
      readFile: {
        description: 'Read a chunk file',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: chunk }),
      },
      edit_sheet_cells: editSheetCells,
    };

    const STEPS = 30;

    async function promptBytes(capped: boolean): Promise<number[]> {
      let step = 0;
      const model = new MockLanguageModelV3({
        doStream: providerEmitting(() => {
          step += 1;
          return step % 2 === 1
            ? JSON.stringify({ tool_name: 'readFile', parameters: { path: `chunk-${step}.json` } })
            : JSON.stringify({
                tool_name: 'edit_sheet_cells',
                parameters: { pageId: `p-${step}`, cells },
              });
        }),
      });
      const result = streamText({
        model,
        messages: [{ role: 'user', content: 'apply all thirty chunks' }],
        tools: { execute_tool: createExecuteTool(mixedRegistry) },
        stopWhen: [stepCountIs(STEPS)],
        ...(capped
          ? {
              prepareStep: ({ messages: m }: { messages: ModelMessage[] }) => ({
                messages: capStepToolPayloads(m),
              }),
            }
          : {}),
      });
      for await (const _part of result.fullStream) {
        void _part;
      }
      await result.content;
      return model.doStreamCalls.map((call) => JSON.stringify(call.prompt).length);
    }

    const uncapped = await promptBytes(false);
    const capped = await promptBytes(true);
    const A_200K_TOKEN_WINDOW = 800_000; // ~4 chars per token

    assert({
      given: "the reporter's alternating read-then-write workload, thirty steps",
      should: 'blow a 200k-token window within a handful of steps uncapped, and stay flat capped',
      actual: {
        uncappedBlowsTheWindowByStepFive: uncapped[4] > A_200K_TOKEN_WINDOW,
        uncappedKeepsGrowing: uncapped[STEPS - 1] > uncapped[4] * 5,
        cappedStaysInsideTheWindow: Math.max(...capped) < A_200K_TOKEN_WINDOW,
        cappedStopsGrowing: capped[STEPS - 1] < capped[9] * 1.5,
      },
      expected: {
        uncappedBlowsTheWindowByStepFive: true,
        uncappedKeepsGrowing: true,
        cappedStaysInsideTheWindow: true,
        cappedStopsGrowing: true,
      },
    });
  }, 300_000);

  it('capping what is SENT never changes what is recorded', async () => {
    // The cap rewrites the messages handed to the provider for one step. If that
    // also reached the run's recorded steps, the fix would be quietly destroying
    // the agent's own history — the arguments it actually sent — which is what
    // persistence and the activity log are built from. Prove it does not.
    const big = 'y'.repeat(50_000);
    const model = new MockLanguageModelV3({
      doStream: providerEmitting(() =>
        JSON.stringify({ tool_name: 'edit_sheet_cells', parameters: { pageId: 'p1', cells: [big] } })
      ),
    });

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'apply every chunk' }],
      tools: { execute_tool: createExecuteTool(registry) },
      stopWhen: [stepCountIs(4)],
      prepareStep: ({ messages: stepMessages }) => ({ messages: capStepToolPayloads(stepMessages) }),
    });
    for await (const _part of result.fullStream) {
      void _part;
    }
    const steps = await result.steps;
    const recorded = steps
      .flatMap((step) => step.content)
      .filter((part) => part.type === 'tool-call')
      .map((part) => JSON.stringify((part as { input: unknown }).input));

    assert({
      given: 'a capped run of four oversized calls',
      should: 'record every call at full size, with no stub anywhere in the history',
      actual: {
        callsRecorded: recorded.length,
        allFullSize: recorded.every((input) => input.includes(big)),
        anyStubbed: recorded.some((input) => input.includes('__payload_elided')),
      },
      expected: { callsRecorded: 4, allFullSize: true, anyStubbed: false },
    });
  });

  it('the per-step cap bounds what one agent loop replays to the provider', async () => {
    // The measured cause. Without capStepToolPayloads the prompt handed to the
    // provider grows by the full payload on every step — 71 bytes at step 1, then
    // dead linear at +103 KB — until the window is gone and the provider starts
    // emitting the argument-less tool calls the tests above reproduce.
    const cells = Array.from({ length: 240 }, (_, i) => ({
      row: i,
      col: 1,
      value: 'x'.repeat(400),
    }));

    const STEPS = 10;

    // Run the identical loop twice — once capped, once not — so the assertion is
    // a measured difference between them, never a threshold arranged to pass.
    async function finalPromptBytes(capped: boolean): Promise<number> {
      let step = 0;
      const model = new MockLanguageModelV3({
        doStream: providerEmitting(() => {
          step += 1;
          return JSON.stringify({
            tool_name: 'edit_sheet_cells',
            parameters: { pageId: `chunk-${step}`, cells },
          });
        }),
      });
      const result = streamText({
        model,
        messages: [{ role: 'user', content: 'apply every chunk' }],
        tools: { execute_tool: createExecuteTool(registry) },
        stopWhen: [stepCountIs(STEPS)],
        // Exactly how global-chat-turn and page-chat-turn wire the seam.
        ...(capped
          ? {
              prepareStep: ({ messages: m }: { messages: ModelMessage[] }) => ({
                messages: capStepToolPayloads(m),
              }),
            }
          : {}),
      });
      for await (const _part of result.fullStream) {
        void _part;
      }
      await result.content;
      const bytes = model.doStreamCalls.map((call) => JSON.stringify(call.prompt).length);
      return bytes[bytes.length - 1];
    }

    const perCallPayload = JSON.stringify({
      tool_name: 'edit_sheet_cells',
      parameters: { pageId: 'chunk-1', cells },
    }).length;
    const uncappedFinal = await finalPromptBytes(false);
    const cappedFinal = await finalPromptBytes(true);

    assert({
      given: `${STEPS} sequential execute_tool calls of ~${Math.round(perCallPayload / 1024)} KB each in one agent loop`,
      should: 'replay every earlier payload uncapped, and stay near a single payload capped',
      actual: {
        uncappedReplaysThemAll: uncappedFinal > (STEPS - 2) * perCallPayload,
        cappedStaysNearOnePayload: cappedFinal < 2 * perCallPayload,
      },
      expected: { uncappedReplaysThemAll: true, cappedStaysNearOnePayload: true },
    });
  });
});

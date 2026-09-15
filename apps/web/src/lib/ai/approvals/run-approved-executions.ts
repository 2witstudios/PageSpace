/**
 * Run the calls a tool-approval resume approved, with the TURN's real tool set
 * and tool context, and report each outcome back onto the original message.
 *
 * Why the turn and not the resume merge: a tool needs `experimental_context`
 * (location, capabilities, working page, dispatch depth…), which only exists
 * once the turn has resolved provider, model and location — and running here,
 * inside the open stream, means a long bash call cannot trip a proxy timeout
 * before the first byte.
 *
 * Every path ends in a RECORDED outcome. A responded part left without a result
 * would be re-run by the SDK's own execute-on-resume next turn (see
 * `core/approval-resume.ts`), so "tool vanished", "input no longer validates",
 * "execute threw" and "aborted" all become `output-error` on the row.
 */

import type { ToolSet } from 'ai';
import type { z } from 'zod';
import type { ApprovedToolExecution, ApprovedToolOutcome } from '@/lib/ai/core/approval-resume';

export interface RunApprovedExecutionsArgs {
  executions: readonly ApprovedToolExecution[];
  /** The turn's FINAL tool set — after every merge and after the approval policy. */
  tools: ToolSet;
  /** Passed to each `execute` as its options; the same object streamText gets. */
  toolOptions: { abortSignal?: AbortSignal; experimental_context: unknown; messages?: unknown[] };
  record: (execution: ApprovedToolExecution, outcome: ApprovedToolOutcome) => Promise<unknown>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface RunApprovedExecutionsResult {
  ran: number;
  failed: number;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Tool execution failed';

export async function runApprovedToolExecutions(args: RunApprovedExecutionsArgs): Promise<RunApprovedExecutionsResult> {
  let ran = 0;
  let failed = 0;

  // Sequential, in approval order: two approved writes may depend on each other
  // (create then edit), and the model issued them in this order.
  for (const execution of args.executions) {
    const tool = Object.hasOwn(args.tools, execution.toolName) ? args.tools[execution.toolName] : undefined;
    let outcome: ApprovedToolOutcome;

    if (!tool || typeof tool.execute !== 'function') {
      // Read-only flipped, a toggle changed, or the tool was removed between
      // pause and resume: refuse rather than run something the turn no longer offers.
      outcome = { ok: false, errorText: `Tool "${execution.toolName}" is no longer available in this conversation, so the approved call did not run.` };
    } else {
      const schema = tool.inputSchema as z.ZodType | undefined;
      const parsed = schema && typeof (schema as z.ZodType).safeParse === 'function'
        ? (schema as z.ZodType).safeParse(execution.input)
        : ({ success: true, data: execution.input } as const);
      if (!parsed.success) {
        outcome = { ok: false, errorText: `The approved call's input no longer validates: ${parsed.error.message}` };
      } else {
        try {
          const output = await (tool.execute as (input: unknown, options: unknown) => unknown)(parsed.data, {
            toolCallId: execution.toolCallId,
            messages: args.toolOptions.messages ?? [],
            abortSignal: args.toolOptions.abortSignal,
            experimental_context: args.toolOptions.experimental_context,
          });
          outcome = { ok: true, output };
        } catch (error) {
          outcome = { ok: false, errorText: errorText(error) };
        }
      }
    }

    if (outcome.ok) ran += 1;
    else {
      failed += 1;
      args.logger?.warn('approved tool execution did not succeed', {
        toolName: execution.toolName,
        toolCallId: execution.toolCallId,
        errorText: outcome.errorText,
      });
    }
    await args.record(execution, outcome);
  }

  return { ran, failed };
}

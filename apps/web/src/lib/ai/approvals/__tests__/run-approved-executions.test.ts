import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { runApprovedToolExecutions } from '../run-approved-executions';
import type { ApprovedToolExecution, ApprovedToolOutcome } from '@/lib/ai/core/approval-resume';

const exec = (over: Partial<ApprovedToolExecution> = {}): ApprovedToolExecution => ({
  approvalId: 'ap1',
  toolCallId: 'tc1',
  toolName: 'trash_page',
  input: { pageId: 'p1' },
  ...over,
});

const harness = (tools: ToolSet) => {
  const recorded: Array<[ApprovedToolExecution, ApprovedToolOutcome]> = [];
  const ctx = { userId: 'u1' };
  const run = (executions: ApprovedToolExecution[]) =>
    runApprovedToolExecutions({
      executions,
      tools,
      toolOptions: { experimental_context: ctx, abortSignal: new AbortController().signal },
      record: async (e, o) => {
        recorded.push([e, o]);
      },
    });
  return { run, recorded, ctx };
};

describe('runApprovedToolExecutions', () => {
  it('runs the tool with the validated input and the shared context, then records output-available', async () => {
    const execute = vi.fn(async (input: unknown) => ({ trashed: input }));
    const { run, recorded, ctx } = harness({
      trash_page: { description: 'd', inputSchema: z.object({ pageId: z.string() }), execute },
    });
    const result = await run([exec()]);
    expect(result).toEqual({ ran: 1, failed: 0 });
    expect(execute).toHaveBeenCalledWith(
      { pageId: 'p1' },
      expect.objectContaining({ toolCallId: 'tc1', experimental_context: ctx, messages: [] }),
    );
    expect(recorded).toEqual([[exec(), { ok: true, output: { trashed: { pageId: 'p1' } } }]]);
  });

  it('records output-error when the tool is no longer in the set (read-only flipped between pause and resume)', async () => {
    const { run, recorded } = harness({});
    expect(await run([exec()])).toEqual({ ran: 0, failed: 1 });
    expect(recorded[0][1]).toEqual({ ok: false, errorText: expect.stringContaining('no longer available') });
  });

  it('records output-error when the input no longer validates, without calling execute', async () => {
    const execute = vi.fn();
    const { run, recorded } = harness({
      trash_page: { description: 'd', inputSchema: z.object({ pageId: z.string().min(5) }), execute },
    });
    expect(await run([exec()])).toEqual({ ran: 0, failed: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(recorded[0][1]).toEqual({ ok: false, errorText: expect.stringContaining('no longer validates') });
  });

  it('records output-error with the thrown message when execute throws, and keeps going', async () => {
    const { run, recorded } = harness({
      trash_page: {
        description: 'd',
        inputSchema: z.object({ pageId: z.string() }),
        execute: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      rename_page: { description: 'd', inputSchema: z.object({}), execute: async () => 'ok' },
    });
    const result = await run([exec(), exec({ approvalId: 'ap2', toolCallId: 'tc2', toolName: 'rename_page', input: {} })]);
    expect(result).toEqual({ ran: 1, failed: 1 });
    expect(recorded.map(([, o]) => o)).toEqual([{ ok: false, errorText: 'boom' }, { ok: true, output: 'ok' }]);
  });

  it('runs approved calls sequentially in approval order', async () => {
    const order: string[] = [];
    const slow = async (name: string, ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
      return name;
    };
    const { run } = harness({
      a: { description: 'd', inputSchema: z.object({}), execute: () => slow('a', 20) },
      b: { description: 'd', inputSchema: z.object({}), execute: () => slow('b', 1) },
    });
    await run([exec({ toolName: 'a', toolCallId: 'x', input: {} }), exec({ toolName: 'b', toolCallId: 'y', input: {} })]);
    expect(order).toEqual(['a', 'b']);
  });
});

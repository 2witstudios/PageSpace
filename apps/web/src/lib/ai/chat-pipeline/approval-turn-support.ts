/**
 * The tool-approval steps both turn strategies take, written once.
 *
 * `handle-chat-turn.ts` argues (correctly) against merging the two turns, and
 * its duplication ratchet refuses new byte-identical runs between them. These
 * two helpers are exactly that run: how a refused resume answers the client, and
 * how approved calls are executed and the model request re-assembled. Each turn
 * supplies its own persistence leg and tool set; the shape of the step is shared.
 */

import { NextResponse } from 'next/server';
import type { ModelMessage, ToolSet } from 'ai';
import type { ApplyToolApprovalResult, ApprovedToolExecution, ApprovedToolOutcome } from '@/lib/ai/core/approval-resume';
import { runApprovedToolExecutions } from '@/lib/ai/approvals/run-approved-executions';

/**
 * A resume that cannot proceed answers before any generation starts (nothing to
 * run, nothing to bill). `null` means "applied — carry on".
 */
export function approvalResumeRefusal(applied: ApplyToolApprovalResult): NextResponse | null {
  switch (applied.kind) {
    case 'not_found':
      return NextResponse.json({ error: 'Message not found', code: 'approval_message_not_found' }, { status: 404 });
    case 'stale':
      return NextResponse.json(
        { error: 'This approval is no longer current — the conversation has moved on.', code: 'approval_stale' },
        { status: 409 },
      );
    case 'already_resolved':
      return NextResponse.json({ error: 'This approval was already answered.', code: 'approval_already_resolved' }, { status: 409 });
    case 'applied':
      return null;
  }
}

export interface AssembledModelRequest {
  modelMessages: ModelMessage[];
  stableBoundaryIndex: number;
}

/**
 * Inside the open stream, with the turn's real tool context: run every approved
 * call, write each outcome onto the ORIGINAL message, then re-assemble the model
 * request from the updated history so the continuation sees the results (and
 * the SDK never runs its own execute-on-resume). Returns the fresh assembly.
 */
export async function executeApprovedCallsAndReassemble<T extends AssembledModelRequest>(args: {
  executions: readonly ApprovedToolExecution[];
  tools: ToolSet;
  toolOptions: { abortSignal?: AbortSignal; experimental_context: unknown };
  record: (execution: ApprovedToolExecution, outcome: ApprovedToolOutcome) => Promise<unknown>;
  loadHistory: () => Promise<Parameters<typeof args.assemble>[0]>;
  assemble: (history: import('ai').UIMessage[]) => Promise<T>;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
  logContext: Record<string, unknown>;
}): Promise<T> {
  const outcome = await runApprovedToolExecutions({
    executions: args.executions,
    tools: args.tools,
    toolOptions: args.toolOptions,
    record: args.record,
    logger: args.logger,
  });
  args.logger.info('approved tool calls executed', { ...args.logContext, ran: outcome.ran, failed: outcome.failed });
  return args.assemble(await args.loadHistory());
}

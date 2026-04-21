import {
  db,
  chatMessages,
  agentRuns,
  agentRunEvents,
  conversations,
  eq,
  asc,
} from '@pagespace/db';
import { initialRunState, applyEvent } from './applyEvent';
import type { RunEvent, RunState } from './types';

export type MaterializeInput = {
  runId: string;
};

export type MaterializeResult = {
  messageId: string;
};

export type Projection = {
  structuredContent: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    state: string;
  }> | null;
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
    state: string;
  }> | null;
  originalContent: string;
};

export function buildProjection(state: RunState): Projection {
  const textParts: string[] = [];
  const partsOrder: Array<{ index: number; type: string; toolCallId?: string }> = [];
  const toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    state: string;
  }> = [];
  const toolResults: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
    state: string;
  }> = [];

  state.parts.forEach((part, index) => {
    if (part.kind === 'text') {
      textParts.push(part.text);
      partsOrder.push({ index, type: 'text' });
      return;
    }
    const sdkState =
      part.state === 'error'
        ? 'output-error'
        : part.state === 'complete'
          ? 'output-available'
          : 'input-available';
    partsOrder.push({ index, type: `tool-${part.toolName}`, toolCallId: part.callId });
    toolCalls.push({
      toolCallId: part.callId,
      toolName: part.toolName,
      input: part.input,
      state: sdkState,
    });
    if (part.state === 'complete' || part.state === 'error') {
      toolResults.push({
        toolCallId: part.callId,
        toolName: part.toolName,
        output: part.output,
        state: sdkState,
      });
    }
  });

  const originalContent = textParts.join('');

  return {
    structuredContent: JSON.stringify({ textParts, partsOrder, originalContent }),
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    toolResults: toolResults.length > 0 ? toolResults : null,
    originalContent,
  };
}

export async function materializeFromLog(
  input: MaterializeInput,
): Promise<MaterializeResult> {
  const { runId } = input;

  const run = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, runId) });
  if (!run) {
    throw new Error(`materializeFromLog: run "${runId}" not found`);
  }
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'aborted') {
    throw new Error(
      `materializeFromLog: run "${runId}" is not terminal (status=${run.status})`,
    );
  }

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, run.conversationId),
  });
  if (!conv) {
    throw new Error(
      `materializeFromLog: conversation "${run.conversationId}" not found`,
    );
  }
  if (conv.type !== 'page' || !conv.contextId) {
    throw new Error(
      `materializeFromLog: conversation "${conv.id}" is not a page conversation (type=${conv.type})`,
    );
  }

  const rows = await db
    .select()
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId))
    .orderBy(asc(agentRunEvents.seq));

  let state: RunState = initialRunState(runId);
  for (const row of rows) {
    const evt = {
      runId,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
    } as RunEvent;
    state = applyEvent(state, evt);
  }

  const projection = buildProjection(state);
  const messageId = runId;

  await db
    .insert(chatMessages)
    .values({
      id: messageId,
      pageId: conv.contextId,
      conversationId: run.conversationId,
      userId: null,
      role: 'assistant',
      content: projection.structuredContent,
      toolCalls: projection.toolCalls ? JSON.stringify(projection.toolCalls) : null,
      toolResults: projection.toolResults ? JSON.stringify(projection.toolResults) : null,
      createdAt: run.completedAt ?? run.startedAt,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: chatMessages.id,
      set: {
        content: projection.structuredContent,
        toolCalls: projection.toolCalls ? JSON.stringify(projection.toolCalls) : null,
        toolResults: projection.toolResults ? JSON.stringify(projection.toolResults) : null,
      },
    });

  return { messageId };
}

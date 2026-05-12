import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import {
  getOrSpawnProcess,
  threadStart,
  threadResume,
  turnStart,
  subscribeToThread,
} from './process-manager';
import type {
  CodexNotification,
  AgentMessageDelta,
  ItemCompletedPayload,
  TurnCompletedPayload,
} from './types';

// Vercel AI SDK data stream helpers
function textPart(text: string): string {
  return `0:${JSON.stringify(text)}\n`;
}

function finishPart(finishReason: string): string {
  return `d:${JSON.stringify({ finishReason, usage: { promptTokens: 0, completionTokens: 0 } })}\n`;
}

function errorPart(message: string): string {
  return `3:${JSON.stringify(message)}\n`;
}

export async function handleCodexChat(opts: {
  userId: string;
  conversationId: string | undefined;
  pageId: string | undefined;
  text: string;
  openAiKey: string;
}): Promise<Response> {
  const { userId, conversationId, text, openAiKey } = opts;

  // Look up or create a codex thread mapping for this conversation
  let codexThreadId: string | null = null;

  if (conversationId) {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { codexThreadId: true },
    });
    codexThreadId = conv?.codexThreadId ?? null;
  }

  // Ensure the process is ready
  await getOrSpawnProcess(userId, openAiKey);

  // Start or resume thread
  let threadId: string;
  if (codexThreadId) {
    const result = await threadResume(userId, openAiKey, { threadId: codexThreadId });
    threadId = result.thread.id;
  } else {
    const result = await threadStart(userId, openAiKey, { approvalPolicy: 'onRequest' });
    threadId = result.thread.id;

    // Persist the mapping
    if (conversationId) {
      await db
        .update(conversations)
        .set({ codexThreadId: threadId })
        .where(eq(conversations.id, conversationId));
    }
  }

  // Start turn — returns initial result; events stream via notifications
  const turnResult = await turnStart(userId, openAiKey, {
    threadId,
    input: [{ type: 'text', text }],
  });
  const turnId = turnResult.turn.id;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };

      const unsubscribe = subscribeToThread(userId, threadId, (notification: CodexNotification) => {
        try {
          handleNotification(notification, turnId, enqueue, () => {
            unsubscribe();
            controller.close();
          });
        } catch {
          // ignore
        }
      });

      // Safety: close after 5 minutes regardless
      setTimeout(() => {
        try {
          unsubscribe();
          enqueue(finishPart('stop'));
          controller.close();
        } catch {
          // already closed
        }
      }, 5 * 60 * 1000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
      'Cache-Control': 'no-cache',
    },
  });
}

function handleNotification(
  notification: CodexNotification,
  activeTurnId: string,
  enqueue: (s: string) => void,
  close: () => void,
): void {
  switch (notification.method) {
    case 'item/agentMessage/delta': {
      const p = notification.params as AgentMessageDelta;
      if (p.delta) enqueue(textPart(p.delta));
      break;
    }

    case 'item/completed': {
      const p = notification.params as ItemCompletedPayload;
      if (p.item.type === 'commandExecution' && p.item.aggregatedOutput) {
        enqueue(textPart(`\n\`\`\`\n${p.item.aggregatedOutput}\n\`\`\`\n`));
      }
      if (p.item.type === 'fileChange' && Array.isArray(p.item.changes)) {
        const summary = p.item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join('\n');
        enqueue(textPart(`\n**File changes:**\n${summary}\n`));
      }
      break;
    }

    case 'turn/completed': {
      const p = notification.params as TurnCompletedPayload;
      if (p.turn.id !== activeTurnId) break;
      if (p.turn.status === 'failed' && p.turn.error) {
        enqueue(errorPart(p.turn.error.message));
      }
      enqueue(finishPart(p.turn.status === 'completed' ? 'stop' : p.turn.status));
      close();
      break;
    }
  }
}

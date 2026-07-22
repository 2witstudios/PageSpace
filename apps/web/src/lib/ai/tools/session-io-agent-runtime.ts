/**
 * Production wiring for the agent half of session IO.
 *
 * Two deps, two seams. The TRANSCRIPT is read relationally from
 * `chat_messages` — the same rows the pane itself renders, keyed by (machine
 * page, agent-terminal id), because a machine agent session's conversation IS
 * an ordinary conversation on the Machine page. The DISPATCH is the headless
 * engine, wired by `buildHeadlessSessionRunDeps`.
 *
 * NO ACCESS CHECK lives here, deliberately, and for the same reason
 * `session-tools-runtime.ts` states it: the conversation's derived handle set
 * is the entitlement and `session-tools.ts` has already authorized this node
 * against it. A second policy site is the review failure-mode for this epic.
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq } from '@pagespace/db/operators';
import { chatMessages } from '@pagespace/db/schema/core';
import { agentSurfaceOf, isAgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import { listAgentTerminals } from '@pagespace/lib/services/machines/agent-terminals';
import { buildListAgentTerminalsDeps } from '@/lib/machines/agent-terminals-runtime';
import {
  dispatchHeadlessSessionTurn,
  type HeadlessDispatchResult,
} from '@/lib/ai/machines/headless-session-run';
import { buildHeadlessSessionRunDeps } from '@/lib/ai/machines/headless-session-run-runtime';
import type { AgentSessionIoDeps, TranscriptResult } from './session-io-agent';
import type { SessionTerminalIdentity } from './session-tools';

/**
 * The agent-terminal row behind an addressed session, or null.
 *
 * The row's id is its conversation id (`machine-pane-binding.ts`: a
 * `pagespace`-typed row IS the pane's identity), so this lookup is what turns
 * a `{target?, name}` address into a transcript key.
 */
async function findChatSurfaceRow(identity: SessionTerminalIdentity): Promise<{ id: string } | null> {
  const listed = await listAgentTerminals({
    machineId: identity.address.machineId,
    ...(identity.address.projectName ? { projectName: identity.address.projectName } : {}),
    ...(identity.address.branchName ? { branchName: identity.address.branchName } : {}),
    deps: buildListAgentTerminalsDeps(),
  });
  if (!listed.ok) return null;

  const row = listed.terminals.find((candidate) => candidate.name === identity.address.name);
  if (!row) return null;
  // Dispatch in `session-tools.ts` already routed by surface; this re-check is
  // about the ROW, not the caller — a row whose agentType was retired since it
  // was created has no transcript to read.
  if (!isAgentRuntimeType(row.agentType) || agentSurfaceOf(row.agentType) !== 'chat') return null;
  return { id: row.id };
}

export function buildAgentSessionIoDeps(): AgentSessionIoDeps {
  return {
    loadTranscript: async (identity, limit): Promise<TranscriptResult> => {
      const row = await findChatSurfaceRow(identity);
      if (!row) return { ok: false, reason: 'not_an_agent_session' };

      // Newest-first with a LIMIT, then reversed: the tail is what matters and
      // the index (pageId, conversationId) already orders it.
      const rows = await db
        .select({
          role: chatMessages.role,
          content: chatMessages.content,
          createdAt: chatMessages.createdAt,
          status: chatMessages.status,
        })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.pageId, identity.address.machineId),
            eq(chatMessages.conversationId, row.id),
            eq(chatMessages.isActive, true),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);

      return {
        ok: true,
        entries: rows
          .reverse()
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({
            role: message.role as 'user' | 'assistant',
            content: message.content,
            at: message.createdAt,
            // A mid-flight placeholder is kept and LABELLED rather than dropped:
            // "the session is still answering" is the single most useful thing a
            // reader can learn here, and an omitted row would read as silence.
            ...(message.status === 'streaming' ? { pending: true as const } : {}),
          })),
      };
    },

    dispatch: async ({ identity, actor, message, depth }): Promise<HeadlessDispatchResult> =>
      dispatchHeadlessSessionTurn(
        { identity, actor, message, depth },
        buildHeadlessSessionRunDeps(),
      ),
  };
}

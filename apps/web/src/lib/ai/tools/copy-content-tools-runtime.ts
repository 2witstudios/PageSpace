/**
 * Production wiring for `copy_content`.
 *
 * Kept separate from the factory so the factory (and its tests) never import
 * the DB or the sandbox driver — the same split `sandbox-tools-runtime.ts` uses
 * for `createSandboxTools`.
 *
 * Note which sandbox read this binds: `readSandboxFileForCopy`, NOT the
 * `readSandboxFile` behind the `readFile` tool. That one windows by line, clips
 * long lines and runs the injection seam, all of which are right for text going
 * to a model and all of which would corrupt bytes going to storage.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import {
  readSandboxFileForCopy,
  writeSandboxFile,
  DENIAL_MESSAGES,
} from '@pagespace/lib/services/sandbox/tool-runners';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canActorViewPage, canActorEditPage } from './actor-permissions';
import { buildAiMutationContext } from './page-write-tools';
import {
  buildRealSandboxRunDeps,
  resolveSandboxActorContext,
  productionSandboxGate,
} from './sandbox-tools-runtime';
import { createCopyContentTools, type CopyContentDeps } from './copy-content-tools';
import type { ToolExecutionContext } from '../core/types';

const copyLogger = loggers.ai.child({ module: 'copy-content-tools' });

/**
 * Resolve the actor + run the standard sandbox gate, then hand back the pieces
 * the copy runners need. Same two-step every sandbox tool performs.
 */
async function openSandbox(context: ToolExecutionContext) {
  const ctx = await resolveSandboxActorContext(context);
  if ('error' in ctx) return { ok: false as const, error: ctx.error };
  const decision = await productionSandboxGate(ctx);
  if (!decision.ok) return { ok: false as const, error: decision.error };
  return { ok: true as const, ctx };
}

/**
 * The per-agent sandbox switch, read at CALL time.
 *
 * `filterToolsForSandboxEnablement` strips by tool NAME and runs once when the
 * tool set is assembled. `copy_content` is a workspace tool (its page→page arm
 * touches no sandbox and must work everywhere), so it is not in
 * `SANDBOX_TOOL_NAMES` and survives that filter — which would otherwise make it
 * a way around the switch. Checking here closes that, and only the file arms
 * ever call it.
 *
 * No agent page in context (the Global Assistant, a workflow step) means there
 * is no per-agent switch to consult, which is exactly the case where the
 * assembly-time filter is not applied either — so the answer is yes, and the
 * `gate` above remains the real authority.
 */
async function isSandboxEnabledForContext(context: ToolExecutionContext): Promise<boolean> {
  const agentPageId = context.chatSource?.agentPageId;
  if (!agentPageId) return true;
  try {
    const [row] = await db
      .select({ sandboxEnabled: pages.sandboxEnabled })
      .from(pages)
      .where(eq(pages.id, agentPageId))
      .limit(1);
    return Boolean(row?.sandboxEnabled);
  } catch (error) {
    // Fail CLOSED: an unreadable switch must not read as "enabled".
    copyLogger.warn('copy_content: could not read the agent sandbox switch; denying file access', { error });
    return false;
  }
}

const productionDeps: CopyContentDeps = {
  findPage: async (pageId) => {
    const page = await pageRepository.findById(pageId);
    if (!page) return null;
    return {
      id: page.id,
      title: page.title,
      type: page.type,
      contentMode: page.contentMode ?? null,
      content: page.content ?? null,
      driveId: page.driveId,
      revision: typeof page.revision === 'number' ? page.revision : null,
    };
  },

  canViewPage: (context, pageId) => canActorViewPage(context, pageId),
  canEditPage: (context, pageId) => canActorEditPage(context, pageId),

  writePageContent: async ({ page, newContent, context, metadata }) => {
    const mutationContext = await buildAiMutationContext(context, { metadata });
    await applyPageMutation({
      pageId: page.id,
      operation: 'update',
      updates: { content: newContent },
      updatedFields: ['content'],
      expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
      context: mutationContext,
    });
    await broadcastPageEvent(
      createPageEventPayload(page.driveId, page.id, 'content-updated', { title: page.title })
    );
  },

  readSandboxFile: async ({ path, context }) => {
    const opened = await openSandbox(context);
    if (!opened.ok) return { success: false, error: opened.error };
    const result = await readSandboxFileForCopy({ path, ctx: opened.ctx, deps: buildRealSandboxRunDeps() });
    return result.success
      ? { success: true, content: result.content, bytes: result.bytes }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason] };
  },

  writeSandboxFile: async ({ path, content, context }) => {
    const opened = await openSandbox(context);
    if (!opened.ok) return { success: false, error: opened.error };
    const result = await writeSandboxFile({ path, content, ctx: opened.ctx, deps: buildRealSandboxRunDeps() });
    return result.success
      ? { success: true, bytesWritten: result.bytesWritten }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason] };
  },

  isSandboxEnabledForContext,
};

export const copyContentTools: { copy_content: Tool } = createCopyContentTools(productionDeps);

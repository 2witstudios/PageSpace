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
 *
 * Real files (uploaded FILE pages into the sandbox, sandbox files into the
 * drive) bind the binary runners instead — `writeSandboxBinaryFile` and
 * `readSandboxBinaryFileForCopy` — and read originals through the processor
 * (`fetchOriginalFromProcessor`), never raw storage, so decryption and the
 * page-bound authorization happen in one place.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import {
  readSandboxFileForCopy,
  writeSandboxFile,
  writeSandboxBinaryFile,
  readSandboxBinaryFileForCopy,
  copySandboxFile,
  MAX_BINARY_COPY_BYTES,
  DENIAL_MESSAGES,
} from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveUploadQuotaTarget, STORAGE_TIERS } from '@pagespace/lib/services/storage-limits';
import { getActorInfo, logFileActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createFilePage } from '@/lib/upload/create-file-page';
import {
  enqueueProcessorJob,
  fetchOriginalFromProcessor,
  reclaimOrphanedOriginal,
  storeOriginalViaProcessor,
} from '@/lib/upload/processor-effects';
import { copyByteBudget, holdUntilHandedOff } from './copy-byte-budget';
import { fetchOriginalUnderBudget } from './copy-content-original-fetch';
import { fileSandboxBytesIntoDrive, type FileIntoDriveEffects } from './copy-content-file-page';
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
import { toolActor } from './actor-permissions';

const copyLogger = loggers.ai.child({ module: 'copy-content-tools' });

/**
 * Resolve the actor + run the standard sandbox gate, then hand back the pieces
 * the copy runners need. Same two-step every sandbox tool performs.
 */
async function openSandbox(context: ToolExecutionContext) {
  const ctx = await resolveSandboxActorContext(context);
  if ('error' in ctx) return { ok: false as const, error: ctx.error };
  const actor = toolActor(context);
  const decision = await productionSandboxGate(ctx, actor);
  if (!decision.ok) return { ok: false as const, error: decision.error };
  return { ok: true as const, ctx, actor };
}

/**
 * The per-agent sandbox switch, read at CALL time.
 *
 * `filterToolsForSandboxEnablement` strips by tool NAME and runs once when the
 * tool set is assembled. `copy_content` is a workspace tool (its page->page arm
 * touches no sandbox and must work everywhere), so it is not in
 * `SANDBOX_TOOL_NAMES` and survives that filter — which would otherwise make it
 * a way around the switch. Checking here closes that, and only the file arms
 * ever call it.
 *
 * WHICH agent is the acting one matters. `ask_agent` builds a nested context
 * for the CONSULTED agent but inherits `chatSource` from the CALLER
 * (`agent-communication-tools.ts`), so keying on `chatSource.agentPageId` alone
 * would read the caller's switch while the consulted agent does the IO — the
 * same "one surface answers differently from the others" contradiction that
 * comment block warns about (#2460). `currentAgentId` is the nested context's
 * record of who is actually running, so it wins when present.
 *
 * No agent page at all means the Global Assistant or a workflow step, neither of
 * which applies the assembly-time filter either, so the answer is yes and the
 * `gate` remains the real authority. (The page-agent CONSULT route is the one
 * surface that applies the filter without setting `chatSource`; its file arms
 * are unreachable regardless, because its synthetic conversation id has no
 * session, so they fail `no_session` before touching a sandbox.)
 */
async function isSandboxEnabledForContext(context: ToolExecutionContext): Promise<boolean> {
  const actingAgentId =
    (context as ToolExecutionContext & { currentAgentId?: string }).currentAgentId ??
    context.chatSource?.agentPageId;
  if (!actingAgentId) return true;
  try {
    const [row] = await db
      .select({ sandboxEnabled: pages.sandboxEnabled })
      .from(pages)
      .where(eq(pages.id, actingAgentId))
      .limit(1);
    return Boolean(row?.sandboxEnabled);
  } catch (error) {
    // Fail CLOSED: an unreadable switch must not read as "enabled".
    copyLogger.warn('copy_content: could not read the agent sandbox switch; denying file access', { error });
    return false;
  }
}

/** The production seams behind filing a sandbox file into the drive. */
const fileIntoDriveEffects: FileIntoDriveEffects = {
  createFilePage,
  storeOriginal: storeOriginalViaProcessor,
  reclaimOriginal: reclaimOrphanedOriginal,
  enqueueProcessorJob,
  broadcast: async ({ driveId, pageId, operation, parentId, title, type }) => {
    await broadcastPageEvent(createPageEventPayload(driveId, pageId, operation, { parentId, title, type }));
  },
  logActivity: async ({ userId, pageId, driveId, title, mimeType, fileSize, contentHash }) => {
    const actorInfo = await getActorInfo(userId);
    logFileActivity(userId, 'upload', { fileId: contentHash, fileName: title, fileType: mimeType, fileSize, driveId, pageId }, actorInfo);
  },
  logError: (message, error, metadata) => copyLogger.error(message, error, metadata),
};

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
      filePath: page.filePath ?? null,
      fileSize: typeof page.fileSize === 'number' ? page.fileSize : null,
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
    const result = await readSandboxFileForCopy({ path, ctx: opened.ctx, deps: buildRealSandboxRunDeps({ actor: opened.actor }) });
    return result.success
      ? { success: true, content: result.content, bytes: result.bytes }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason] };
  },

  writeSandboxFile: async ({ path, content, context }) => {
    const opened = await openSandbox(context);
    if (!opened.ok) return { success: false, error: opened.error };
    const result = await writeSandboxFile({ path, content, ctx: opened.ctx, deps: buildRealSandboxRunDeps({ actor: opened.actor }) });
    return result.success
      ? { success: true, bytesWritten: result.bytesWritten }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason] };
  },

  fetchFileOriginal: ({ page, deadlineAt, context }) =>
    fetchOriginalUnderBudget(
      { page, deadlineAt },
      {
        budget: copyByteBudget,
        fetchOriginal: ({ pageId, filePath, maxBytes, deadlineAt: until }) =>
          fetchOriginalFromProcessor({ actor: toolActor(context), pageId, filePath, maxBytes, deadlineAt: until }),
        maxCopyBytes: MAX_BINARY_COPY_BYTES,
        budgetExhaustedMessage: DENIAL_MESSAGES.copy_budget_exhausted,
      }
    ),

  writeSandboxBinaryFile: async ({ path, content, deadlineAt, context }) => {
    const opened = await openSandbox(context);
    if (!opened.ok) return { success: false, error: opened.error };
    const result = await writeSandboxBinaryFile({
      path,
      content,
      deadlineAt,
      ctx: opened.ctx,
      deps: buildRealSandboxRunDeps({ actor: opened.actor }),
    });
    return result.success
      ? { success: true, bytesWritten: result.bytesWritten }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason], reason: result.reason };
  },

  readSandboxBinaryFile: async ({ path, maxBytes, deadlineAt, context }) => {
    const opened = await openSandbox(context);
    if (!opened.ok) return { success: false, error: opened.error };
    // The runner probes the file's size and offers it here (between its two
    // sessions) BEFORE reading, so the bytes are reserved before they arrive.
    // holdUntilHandedOff gives the reservation back if the read fails OR throws.
    const { result, release } = await holdUntilHandedOff(copyByteBudget, (reserve) =>
      readSandboxBinaryFileForCopy({
        path,
        maxBytes,
        deadlineAt,
        admit: reserve,
        ctx: opened.ctx,
        deps: buildRealSandboxRunDeps({ actor: opened.actor }),
      })
    );
    return result.success
      ? { success: true, content: result.content, release }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason], reason: result.reason };
  },

  // Inside the sandbox: nothing reaches this server, so nothing is reserved.
  copySandboxFile: async ({ fromPath, toPath, deadlineAt, context }) => {
    const opened = await openSandbox(context);
    if (!opened.ok) return { success: false, error: opened.error };
    const result = await copySandboxFile({
      fromPath,
      toPath,
      deadlineAt,
      ctx: opened.ctx,
      deps: buildRealSandboxRunDeps({ actor: opened.actor }),
    });
    return result.success
      ? { success: true, bytesWritten: result.bytesWritten }
      : { success: false, error: result.error ?? DENIAL_MESSAGES[result.reason], reason: result.reason };
  },

  // The per-file limit of whoever PAYS for the drive's storage (the org for an
  // org drive, the owner otherwise) — the same target the quota check uses.
  resolveMaxFileSize: async ({ driveId, context }) => {
    const target = await resolveUploadQuotaTarget(context.userId, driveId);
    return target ? STORAGE_TIERS[target.quota.tier].maxFileSize : null;
  },

  createFilePage: ({ parent, title, path, content, deadlineAt, context }) =>
    fileSandboxBytesIntoDrive({ actor: toolActor(context), parent, title, path, content, deadlineAt }, fileIntoDriveEffects),

  isSandboxEnabledForContext,
};

export const copyContentTools: { copy_content: Tool } = createCopyContentTools(productionDeps);

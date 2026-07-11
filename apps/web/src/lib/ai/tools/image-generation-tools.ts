import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { IMAGE_GEN_HOLD_ESTIMATE_CENTS, resolveImageCost } from '@pagespace/lib/billing/credit-pricing';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';
import type { ToolExecutionContext } from '../core/types';
import { DEFAULT_IMAGE_MODEL } from '../core/model-capabilities';
import { generateImageBytes, ImageGenerationError } from '../core/image-generation';
import { isImageGenerationAllowed } from '../core/image-gen-access';
import { createImageFilePage, ImageStorageQuotaError } from '@/lib/upload/create-file-page';

const imageLogger = loggers.ai.child({ module: 'image-generation-tools' });

/**
 * Load the user's app-admin flag + subscription tier (defensive fallback when not
 * threaded via experimental_context, e.g. non-chat tool callers).
 */
async function loadUserGating(userId: string): Promise<{ isAdmin: boolean; tier: SubscriptionTier }> {
  const rows = await db
    .select({ role: users.role, tier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    isAdmin: rows[0]?.role === 'admin',
    tier: (rows[0]?.tier ?? 'free') as SubscriptionTier,
  };
}

/** Derive a concise page/file title from the prompt. */
function titleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed || 'Generated image';
}

export const imageGenerationTools = {
  generate_image: tool({
    description: `Generate an image from a text prompt using the user's configured image model.
The image is saved to the user's drive (a "Generated Images" folder in their Home drive by default)
and shown inline in the conversation. Use this when the user asks you to create, draw, generate, or
illustrate an image, logo, diagram, or picture. Currently restricted to app administrators.`,
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .describe('A detailed description of the image to generate (subject, style, composition, lighting).'),
      aspectRatio: z
        .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
        .optional()
        .describe('Optional aspect ratio hint (default square). Some models may ignore it.'),
    }),
    execute: async (
      { prompt, aspectRatio },
      { experimental_context: rawContext },
    ) => {
      const context = rawContext as ToolExecutionContext | undefined;
      const userId = context?.userId;
      if (!userId) {
        throw new Error('User authentication required for image generation');
      }

      // Admin-only rollout gate (defensive — the route also gates exposure). Fast-path
      // from context; fall back to a DB read so the tool self-defends regardless of caller.
      let isAdmin = context?.isAdmin;
      let tier = context?.subscriptionTier as SubscriptionTier | undefined;
      if (isAdmin === undefined || tier === undefined) {
        const gating = await loadUserGating(userId);
        isAdmin = isAdmin ?? gating.isAdmin;
        tier = tier ?? gating.tier;
      }
      if (!isImageGenerationAllowed(isAdmin)) {
        return {
          success: false,
          error: 'Image generation is currently restricted to app administrators.',
        };
      }

      const model = context?.imageGenerationModel || DEFAULT_IMAGE_MODEL;

      // Reserve credits for the call (image-sized estimate; real cost settles at trackUsage).
      const gate = await canConsumeAI(userId, (tier ?? 'free') as SubscriptionTier, {
        estCostCents: IMAGE_GEN_HOLD_ESTIMATE_CENTS,
      });
      if (!gate.allowed) {
        return {
          success: false,
          error: 'Insufficient credits to generate an image. Ask the user to top up their balance.',
        };
      }
      const holdId = gate.holdId;

      /**
       * Settle the reserved hold against real provider spend.
       *
       * INVARIANT: once the OpenRouter round-trip COMPLETES we have been charged, so the
       * spend must be recorded — even if a later step (saving the file) fails. Releasing
       * the hold there instead would leave real provider spend with no ai_usage_logs row
       * and no debit.
       *
       * Every settle passes `success: true` — including failed-but-billable spend — because
       * trackAIUsage only bills when `success` is true OR tokens were consumed, and image
       * calls carry no token counts. Marking these rows `success: false` would therefore
       * skip billing entirely and reintroduce the leak. The tradeoff is that a failed-but-
       * billed generation is invisible to the success/failure analytics that filter on
       * `success = false` (error-pattern detection, successRate): use the `error` tag and
       * `metadata.outcome` (`store_failed` / `no_image_returned`) to find them instead.
       */
      const settleSpend = async (args: {
        providerCostDollars?: number;
        generationIds: string[];
        mediaType?: string;
        driveId?: string;
        pageId?: string;
        error?: string;
      }) => {
        const resolved = resolveImageCost(args.providerCostDollars);
        await AIMonitoring.trackUsage({
          userId,
          provider: 'openrouter',
          model,
          providerCostDollars: resolved.costDollars,
          costSource: resolved.costSource,
          openrouterGenerationIds: args.generationIds,
          holdId,
          success: true,
          source: 'image_generation',
          conversationId: context?.conversationId,
          driveId: args.driveId,
          pageId: args.pageId,
          ...(args.error ? { error: args.error } : {}),
          metadata: {
            imageModel: model,
            mediaType: args.mediaType,
            costSource: resolved.costSource,
            ...(args.error ? { outcome: args.error } : {}),
          },
        }).catch((metErr) => {
          // Defensive only — currently UNREACHABLE: trackAIUsage wraps its whole body in a
          // logging try/catch and never rejects (it logs the swallowed failure at ERROR
          // itself, which is where an unbilled generation actually surfaces). Kept so a
          // future change that lets it throw can't silently fail the user's request.
          imageLogger.error('Failed to record image usage', metErr as Error, {
            userId: maskIdentifier(userId),
            model,
            costDollars: resolved.costDollars,
            generationIds: args.generationIds,
          });
        });

        // Belt-and-braces hold cleanup. trackAIUsage SWALLOWS its own errors (every branch
        // is wrapped in a logging try/catch), so a rejection is NOT a reliable signal that
        // the settle landed: if `writeAiUsage` throws, the throw is caught internally and
        // the settle/release branches below it never run, leaving the hold neither settled
        // nor released — it would strand the user's reserved credits until TTL expiry.
        //
        // Deleting the hold here is safe and idempotent: consumeCredits already removes it
        // inside its settle transaction (and in the zero-charge branch), so on the happy path
        // this deletes zero rows — releaseHold emits only when a row actually came back, so
        // there is no duplicate balance push. A hold is a pure RESERVATION (the gate sums
        // creditHolds.estCents against spendable); deleting one never credits the balance, so
        // this can't refund a settled charge.
        //
        // Edge case, accepted: if consumeCredits' transaction failed, the ledger row stays
        // 'pending' and settlePendingLedgerRow debits it later — releasing the hold here means
        // that pending debit is briefly under-reserved. No double-credit results; the only
        // effect is a slightly optimistic spendable for one in-flight call.
        if (holdId) await releaseHold(holdId).catch(() => {});
      };

      let image;
      try {
        image = await generateImageBytes({ prompt, model, aspectRatio });
      } catch (error) {
        // A completed-but-empty generation was still billed by OpenRouter → settle it, but
        // ONLY against an AUTHORITATIVE cost (`usage.cost`, including a legitimate $0 from a
        // free model — hence `!== undefined`, not truthiness).
        //
        // A generation id is NOT sufficient evidence: `reconcileStatus` is set only when
        // `hasRealCost && generationIds.length > 0` (ai-monitoring), and the reconcile cron
        // picks up only `'pending'` rows — so an id-only row settled at the flat estimate
        // would be a permanent, unreconcilable charge for a generation that produced nothing.
        // Without an authoritative cost we cannot substantiate the amount, so we release the
        // hold rather than invent a charge. (We may under-bill a failed call; we never
        // over-bill one.)
        //
        // A transport/auth failure never reached the provider → release the hold.
        const imgErr = error instanceof ImageGenerationError ? error : null;
        if (imgErr?.billable && imgErr.providerCostDollars !== undefined) {
          await settleSpend({
            providerCostDollars: imgErr.providerCostDollars,
            generationIds: imgErr.generationIds,
            error: 'no_image_returned',
          });
        } else if (holdId) {
          await releaseHold(holdId).catch(() => {});
        }
        imageLogger.warn('Image generation failed', {
          userId: maskIdentifier(userId),
          model,
          billable: error instanceof ImageGenerationError ? error.billable : false,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error:
            error instanceof ImageGenerationError
              ? error.message
              : 'Image generation failed. The model may be unavailable — try again or a different prompt.',
        };
      }

      const title = titleFromPrompt(prompt);
      let created;
      try {
        created = await createImageFilePage({
          userId,
          buffer: Buffer.from(image.bytes),
          mimeType: image.mediaType,
          title,
          prompt,
        });
      } catch (error) {
        // The image WAS generated (and billed) — settle the spend rather than release,
        // otherwise real provider cost goes unrecorded. The user still gets a failure.
        await settleSpend({
          providerCostDollars: image.providerCostDollars,
          generationIds: image.generationIds,
          mediaType: image.mediaType,
          error: 'store_failed',
        });
        imageLogger.error('Failed to save generated image', error as Error, {
          userId: maskIdentifier(userId),
        });
        const message =
          error instanceof ImageStorageQuotaError
            ? error.message
            : 'The image was generated but could not be saved to your drive.';
        return { success: false, error: message };
      }

      await settleSpend({
        providerCostDollars: image.providerCostDollars,
        generationIds: image.generationIds,
        mediaType: image.mediaType,
        driveId: created.driveId,
        pageId: created.pageId,
      });

      imageLogger.info('Image generated', {
        userId: maskIdentifier(userId),
        model,
        mediaType: image.mediaType,
        pageId: created.pageId,
      });

      return {
        success: true,
        pageId: created.pageId,
        viewUrl: `/api/files/${created.pageId}/view`,
        title,
        mediaType: image.mediaType,
        prompt,
        summary: `Generated an image for "${title}" and saved it to the drive.`,
      };
    },
  }),
};

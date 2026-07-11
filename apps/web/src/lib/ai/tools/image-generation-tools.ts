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

      let image;
      try {
        image = await generateImageBytes({ prompt, model, aspectRatio });
      } catch (error) {
        if (holdId) await releaseHold(holdId).catch(() => {});
        imageLogger.warn('Image generation failed', {
          userId: maskIdentifier(userId),
          model,
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
        if (holdId) await releaseHold(holdId).catch(() => {});
        imageLogger.error('Failed to save generated image', error as Error, {
          userId: maskIdentifier(userId),
        });
        const message =
          error instanceof ImageStorageQuotaError
            ? error.message
            : 'The image was generated but could not be saved to your drive.';
        return { success: false, error: message };
      }

      // Settle the hold at the real cost (or the flat estimate when OpenRouter omits it).
      const resolved = resolveImageCost(image.providerCostDollars);
      await AIMonitoring.trackUsage({
        userId,
        provider: 'openrouter',
        model,
        providerCostDollars: resolved.costDollars,
        costSource: resolved.costSource,
        openrouterGenerationIds: image.generationIds,
        holdId,
        success: true,
        source: 'image_generation',
        conversationId: context?.conversationId,
        driveId: created.driveId,
        pageId: created.pageId,
        metadata: { imageModel: model, mediaType: image.mediaType, costSource: resolved.costSource },
      }).catch((error) => {
        // Never fail the user-facing result on a metering error; log and move on.
        imageLogger.error('Failed to record image usage', error as Error, {
          userId: maskIdentifier(userId),
        });
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

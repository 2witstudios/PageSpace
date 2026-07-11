/**
 * Image-generation shell — turns a prompt + OpenRouter image model into raw image
 * bytes + mediaType + real cost. One seam so the `generate_image` tool never talks to
 * OpenRouter directly.
 *
 * Path (verified live in leaf 2-0): OpenRouter chat-completions with
 * `extraBody.modalities = ['image','text']` returns the image as an AI-SDK file part
 * (`result.files[0]`), and `usage: { include: true }` puts the authoritative cost at
 * `providerMetadata.openrouter.usage.cost`. The pure extractors below read that shape;
 * the thin shell performs the call with an injectable client + generate fn (DI) so
 * tests never hit the network.
 */

import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { getManagedProviderKey } from './ai-utils';

/** Result of a successful image generation. */
export interface GeneratedImage {
  bytes: Uint8Array;
  mediaType: string;
  /** OpenRouter's authoritative cost in USD, when present (usage.cost). */
  providerCostDollars?: number;
  /** OpenRouter generation ids for async cost reconciliation (may be empty). */
  generationIds: string[];
}

/** Thrown when the model returns no image (mapped by the tool to a failed result). */
export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

/** The subset of a `generateText` result the extractors read (pure, fixture-testable). */
export interface ImageGenResult {
  files?: Array<{ mediaType?: string; uint8Array?: Uint8Array }>;
  providerMetadata?: Record<string, unknown>;
  response?: { id?: string };
}

/** Pure: first image file in the result, or null when none was produced. */
export function extractImageFromResult(
  result: ImageGenResult,
): { bytes: Uint8Array; mediaType: string } | null {
  const file = result.files?.find(
    (f) => typeof f.mediaType === 'string' && f.mediaType.startsWith('image/') && f.uint8Array,
  );
  if (!file?.uint8Array || !file.mediaType) return null;
  return { bytes: file.uint8Array, mediaType: file.mediaType };
}

/** Pure: OpenRouter usage cost (USD) if present, else undefined. */
export function extractImageCost(result: ImageGenResult): number | undefined {
  const openrouter = result.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined;
  const cost = openrouter?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/** Pure: OpenRouter generation ids for reconcile (from provider metadata or response id). */
export function extractImageGenerationIds(result: ImageGenResult): string[] {
  const openrouter = result.providerMetadata?.openrouter as { id?: string } | undefined;
  const id = openrouter?.id ?? result.response?.id;
  return typeof id === 'string' && id.length > 0 ? [id] : [];
}

export type OpenRouterImageClient = ReturnType<typeof createOpenRouter>;
type ImageGenerateFn = (args: { model: LanguageModel; prompt: string }) => Promise<ImageGenResult>;

/** Build the managed OpenRouter client (mirrors provider-factory's config). Throws if unconfigured. */
export function createOpenRouterImageClient(): OpenRouterImageClient {
  const managed = getManagedProviderKey('openrouter');
  if (!managed?.apiKey) {
    throw new ImageGenerationError('OpenRouter provider is not configured on this deployment.');
  }
  return createOpenRouter({
    apiKey: managed.apiKey,
    ...(process.env.OPENROUTER_BASE_URL ? { baseURL: process.env.OPENROUTER_BASE_URL } : {}),
    headers: { 'X-OpenRouter-Cache': 'true' },
  });
}

export interface GenerateImageBytesDeps {
  client?: OpenRouterImageClient;
  generate?: ImageGenerateFn;
}

/**
 * Generate one image via OpenRouter and return its bytes + mediaType + cost. The
 * OpenRouter client and generate fn are injectable so unit tests avoid the network.
 */
export async function generateImageBytes(
  { prompt, model, aspectRatio }: { prompt: string; model: string; aspectRatio?: string },
  deps: GenerateImageBytesDeps = {},
): Promise<GeneratedImage> {
  const client = deps.client ?? createOpenRouterImageClient();
  // Default to the real generateText; the single cast is confined to this DI boundary
  // (the real result is a structural superset of ImageGenResult).
  const generate: ImageGenerateFn =
    deps.generate ?? ((args) => generateText(args) as unknown as Promise<ImageGenResult>);

  const extraBody: Record<string, unknown> = { modalities: ['image', 'text'] };
  if (aspectRatio) extraBody.image_config = { aspect_ratio: aspectRatio };

  const result = await generate({
    model: client.chat(model, { usage: { include: true }, extraBody }),
    prompt,
  });

  const image = extractImageFromResult(result);
  if (!image) {
    throw new ImageGenerationError('Image model returned no image for the given prompt.');
  }

  return {
    bytes: image.bytes,
    mediaType: image.mediaType,
    providerCostDollars: extractImageCost(result),
    generationIds: extractImageGenerationIds(result),
  };
}

/**
 * AI sub-processor erasure forwarding (GDPR Art 17(2)) — #912.
 *
 * On erasure we must account for any user data held by AI providers. PageSpace
 * routes cloud inference through a gateway under a Zero-Data-Retention posture,
 * so for those providers the obligation is satisfied by recording ZDR reliance
 * as evidence; local providers store nothing externally; anything unrecognised
 * is escalated for manual review. The classification is pure; forwarding is a
 * thin best-effort edge.
 */

import type { DeploymentMode } from './erasure-plan';

export type AiErasureAction = 'forward_deletion' | 'rely_on_zdr' | 'skip_local' | 'manual_review';

export interface AiProviderErasureEntry {
  provider: string;
  action: AiErasureAction;
  note: string;
}

export interface AiProviderErasureManifest {
  userId: string;
  entries: AiProviderErasureEntry[];
  requiresManualReview: boolean;
}

export interface BuildAiManifestInput {
  userId: string;
  /** Distinct providers the user actually invoked (from ai_usage logs). */
  providers: string[];
  deploymentMode: DeploymentMode;
}

// Providers that run on infrastructure the operator controls — nothing leaves.
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

// Cloud providers reached under the gateway's Zero-Data-Retention posture.
const ZDR_PROVIDERS = new Set([
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'xai',
  'grok',
  'deepseek',
  'mistral',
  'openai_voice',
  'azure_openai',
  'glm',
]);

function classifyProvider(provider: string, cloudLike: boolean): AiProviderErasureEntry {
  if (!cloudLike || LOCAL_PROVIDERS.has(provider)) {
    return {
      provider,
      action: 'skip_local',
      note: 'Local/self-hosted provider — no data retained at an external processor.',
    };
  }
  if (ZDR_PROVIDERS.has(provider)) {
    return {
      provider,
      action: 'rely_on_zdr',
      note: 'Routed under gateway Zero-Data-Retention; no prompt/response retained at rest.',
    };
  }
  return {
    provider,
    action: 'manual_review',
    note: 'Unrecognised provider — operator must confirm retention posture manually.',
  };
}

export function buildAiProviderErasureManifest(
  input: BuildAiManifestInput
): AiProviderErasureManifest {
  const cloudLike = input.deploymentMode === 'cloud' || input.deploymentMode === 'tenant';

  const normalized = Array.from(
    new Set(input.providers.map((p) => p.trim().toLowerCase()).filter(Boolean))
  ).sort();

  const entries = normalized.map((p) => classifyProvider(p, cloudLike));

  return {
    userId: input.userId,
    entries,
    requiresManualReview: entries.some((e) => e.action === 'manual_review'),
  };
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

export interface AiProviderForwarder {
  /** Forward an explicit deletion request to a provider that supports one. */
  forwardDeletion: (entry: AiProviderErasureEntry, userId: string) => Promise<void>;
}

export interface AiProviderErasureOptions {
  /**
   * When true, ZDR-reliant providers are also sent a best-effort forwarded
   * deletion request (for providers that later expose such an API). Defaults to
   * false because the gateway exposes no per-user deletion endpoint today.
   */
  forwardZdr?: boolean;
}

export interface AiProviderErasureResult {
  forwarded: number;
  failed: number;
  /** One evidence line per provider for the DSR step record. */
  evidence: AiProviderErasureEntry[];
}

export async function eraseAiProviderData(
  input: BuildAiManifestInput,
  forwarder: AiProviderForwarder,
  options: AiProviderErasureOptions = {}
): Promise<AiProviderErasureResult> {
  const manifest = buildAiProviderErasureManifest(input);
  let forwarded = 0;
  let failed = 0;

  for (const entry of manifest.entries) {
    const shouldForward =
      entry.action === 'forward_deletion' || (options.forwardZdr && entry.action === 'rely_on_zdr');
    if (!shouldForward) continue;

    try {
      await forwarder.forwardDeletion(entry, manifest.userId);
      forwarded += 1;
    } catch {
      // Never block erasure on a provider's availability.
      failed += 1;
    }
  }

  return { forwarded, failed, evidence: manifest.entries };
}

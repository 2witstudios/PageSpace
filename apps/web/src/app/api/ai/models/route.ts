import { buildModelCatalog } from '@/lib/ai/core/model-catalog';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '@/lib/ai/core/ai-providers-config';

/**
 * GET /api/ai/models — PUBLIC model catalog.
 *
 * Returns the real AI providers and models (grouped by provider) so clients and
 * agents configure agents against actual model ids instead of hallucinating them.
 * No auth: the catalog already ships to the browser and is not secret. Pricing is
 * intentionally NOT included.
 *
 * This is distinct from the OpenAI-compatible `/api/v1/models`, which lists
 * PageSpace *agents* as models for SDK inference — leave that one untouched.
 */
export async function GET(): Promise<Response> {
  return Response.json(
    {
      providers: buildModelCatalog(),
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    },
  );
}

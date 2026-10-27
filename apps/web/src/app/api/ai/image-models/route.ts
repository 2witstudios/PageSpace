import { fetchOpenRouterImageModels } from '@/lib/ai/core/model-capabilities';
import { isOnPrem } from '@pagespace/lib/deployment-mode';

/**
 * GET /api/ai/image-models — PUBLIC list of OpenRouter image-capable models.
 *
 * Mirrors `/api/ai/models`: the model list is not secret and ships to the browser
 * for the image-generation settings picker. Pricing is intentionally NOT included.
 * On-prem returns an empty list — image generation is a cloud integration. The list
 * is best-effort; upstream failures degrade to `{ models: [] }` (never a 500).
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const models = isOnPrem() ? [] : await fetchOpenRouterImageModels();

  return Response.json(
    { models },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    },
  );
}

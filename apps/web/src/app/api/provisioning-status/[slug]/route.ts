import { loggers } from '@pagespace/lib/logging/logger-config';

// Mirrors control-plane's tenant-validation.ts SLUG_PATTERN
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;

  if (!slug || slug.length < 3 || slug.length > 63 || !SLUG_PATTERN.test(slug)) {
    return Response.json({ error: 'Invalid slug' }, { status: 400 });
  }

  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  if (!controlPlaneUrl) {
    return Response.json(
      { error: 'Provisioning service unavailable' },
      { status: 503 }
    );
  }

  try {
    const response = await fetch(`${controlPlaneUrl}/api/tenants/${slug}`, {
      headers: {
        'X-API-Key': process.env.CONTROL_PLANE_API_KEY || '',
      },
    });

    if (!response.ok) {
      return Response.json(
        { error: `Tenant not found` },
        { status: response.status }
      );
    }

    const data = await response.json() as { slug: string; status: string };

    // Only expose slug and status to the client — no internal details
    return Response.json({
      slug: data.slug,
      status: data.status,
    });
  } catch (error) {
    loggers.api.error('Failed to reach control-plane', error instanceof Error ? error : undefined, { slug });
    return Response.json(
      { error: 'Failed to reach provisioning service' },
      { status: 502 }
    );
  }
}

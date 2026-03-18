import { loggers } from '@pagespace/lib/server';

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;

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

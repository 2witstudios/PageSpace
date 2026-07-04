import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

// Metadata depends on runtime env config, not build-time state.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const issuer = process.env.WEB_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';

  return Response.json(buildServerMetadata({ issuer }), {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

// Metadata depends on runtime env config, not build-time state.
export const dynamic = 'force-dynamic';

// Rewritten to from the RFC 8414 well-known URL by next.config.ts, because
// Next.js App Router does not route dot-prefixed folders (app/.well-known/*
// never lands in the build manifest). Deliberately not under api/oauth/: this
// is unauthenticated-by-spec public metadata with nothing to rate-limit or
// audit, and api/oauth/__tests__/hardening.test.ts enforces zero exceptions
// for routes that live there.
export async function GET(): Promise<Response> {
  const issuer = process.env.WEB_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';

  return Response.json(buildServerMetadata({ issuer }), {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

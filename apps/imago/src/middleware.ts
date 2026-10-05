import { NextResponse, type NextRequest } from 'next/server';
import { createSecureResponse } from '@/middleware/security-headers';
import { PATHNAME_HEADER, SESSION_COOKIE, signInLocation } from '@/lib/auth/sign-in-url';
import { isImagoEnabled } from '@/lib/imago-enabled';

// Liveness probes run without a session, and while imago is switched off.
const PUBLIC_PATHS = new Set(['/api/health']);

export function middleware(req: NextRequest): NextResponse {
  // nextUrl.pathname is relative to basePath: /imago/api/health → /api/health.
  const { pathname, origin } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.has(pathname);

  // Switched off, imago does not exist: no sign-in redirect, no render. Not
  // cached, so turning the flag on takes effect on the next request.
  if (!isImagoEnabled() && !isPublic) {
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  // Presence only: the edge cannot reach the database. getViewer() validates
  // the session in server code and sends invalid or revoked ones to sign-in.
  if (!isPublic && !req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.redirect(signInLocation({ origin, pathname }));
  }

  const isAPIRoute = pathname.startsWith('/api');
  const isProduction = process.env.NODE_ENV === 'production';
  return createSecureResponse(isProduction, req, {
    isAPIRoute,
    forwardHeaders: { [PATHNAME_HEADER]: pathname },
  }).response;
}

// Matchers are prefixed with basePath, and `/imago/(...)` alone never matches
// the bare `/imago` root, so the root gets its own entry. Router prefetches
// skip middleware: they render nothing, so they need no nonce. The config is
// parsed statically at build time, so each entry is written out literally.
export const config = {
  matcher: [
    {
      source: '/',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

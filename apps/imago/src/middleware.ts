import { NextResponse, type NextRequest } from 'next/server';
import { createSecureResponse } from '@/middleware/security-headers';
import {
  PATHNAME_HEADER,
  SESSION_COOKIE,
  signInLocation,
  webAppOrigin,
} from '@/lib/auth/sign-in-url';
import { isImagoEnabled } from '@/lib/imago-enabled';

// Liveness probes run without a session, and while imago is switched off.
const PUBLIC_PATHS = new Set(['/api/health']);

export function middleware(req: NextRequest): NextResponse {
  // nextUrl.pathname is relative to basePath: /imago/api/health → /api/health.
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.has(pathname);

  // Switched off, imago does not exist: no sign-in redirect, no render. Not
  // cached, so turning the flag on takes effect on the next request.
  if (!isImagoEnabled() && !isPublic) {
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  // Presence only: the edge cannot reach the database. getViewer() validates
  // the session in server code and sends invalid or revoked ones to sign-in.
  // Built on the configured origin, as getViewer() does: nextUrl's origin is
  // the Host header, which the client writes.
  if (!isPublic && !req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.redirect(signInLocation({ origin: webAppOrigin(), pathname }));
  }

  const isAPIRoute = pathname.startsWith('/api');
  const isProduction = process.env.NODE_ENV === 'production';
  // Exactly 'development': `next build` inlines NODE_ENV as 'production', so
  // the production middleware bundle can never take this branch.
  const isDevelopment = process.env.NODE_ENV === 'development';
  return createSecureResponse(isProduction, req, {
    isAPIRoute,
    isDevelopment,
    forwardHeaders: { [PATHNAME_HEADER]: pathname },
  }).response;
}

// Matchers are prefixed with basePath, and `/imago/(...)` alone never matches
// the bare `/imago` root, so the root gets its own entries. Every client can
// send the prefetch headers, so they must not open a way past the gates:
// - API routes always run middleware: route handlers never render the root
//   layout, whose notFound() backstops the flag for pages.
// - Pages skip it only for a real router prefetch (RSC with
//   next-router-prefetch: 1), which renders no page and so needs no nonce
//   (a runtime prefetch, value 2, renders the page and so runs it); the
//   root layout keeps those behind the flag. A matcher entry runs middleware
//   when no `missing` header is present, so the two entries per page source
//   leave out exactly the requests that carry both.
// The config is parsed statically at build time, so each entry is written out
// literally.
export const config = {
  matcher: [
    '/api/:path*',
    { source: '/', missing: [{ type: 'header', key: 'rsc', value: '1' }] },
    { source: '/', missing: [{ type: 'header', key: 'next-router-prefetch', value: '1' }] },
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'rsc', value: '1' }],
    },
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch', value: '1' }],
    },
  ],
};

import type { NextRequest, NextResponse } from 'next/server';
import { createSecureResponse } from '@/middleware/security-headers';

export function middleware(req: NextRequest): NextResponse {
  // nextUrl.pathname is relative to basePath: /imago/api/health → /api/health.
  const isAPIRoute = req.nextUrl.pathname.startsWith('/api');
  const isProduction = process.env.NODE_ENV === 'production';
  return createSecureResponse(isProduction, req, { isAPIRoute }).response;
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

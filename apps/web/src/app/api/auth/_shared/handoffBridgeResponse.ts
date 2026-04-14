import { NextResponse } from 'next/server';
import { buildHandoffBridgeHtml } from './buildHandoffBridgeHtml';

const HANDOFF_BRIDGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HANDOFF_BRIDGE_BODY =
  'Return to the PageSpace desktop app — you can safely close this window.';

export const buildHandoffBridgeResponse = (
  deepLink: string,
  title: string,
): NextResponse => {
  const html = buildHandoffBridgeHtml({
    deepLink,
    title,
    body: HANDOFF_BRIDGE_BODY,
  });
  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': HANDOFF_BRIDGE_CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};

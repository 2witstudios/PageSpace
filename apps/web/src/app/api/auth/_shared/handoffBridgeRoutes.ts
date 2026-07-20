// Single source of truth for the OAuth callback request paths that return the
// styled HTML "handoff bridge" page (buildHandoffBridgeResponse) with its own
// bespoke CSP. The edge middleware reads this (via isHandoffBridgeRoute) to skip
// its restrictive API CSP for these paths, so it doesn't intersect with and
// clobber the route's own policy — see ./handoffBridgeResponse.ts.
//
// Keep in sync with the routes that actually call buildHandoffBridgeResponse:
//   ../google/callback/route.ts (desktop branch)
//   ../apple/callback/route.ts  (desktop branch)
//
// Pure leaf (no imports) so it stays safe to pull into the Edge-runtime
// middleware graph — same rationale as the token-prefixes leaf.
export const HANDOFF_BRIDGE_ROUTE_PATHS = [
  '/api/auth/google/callback',
  '/api/auth/apple/callback',
] as const;

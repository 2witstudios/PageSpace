// Where next.config sends a document (non-RSC) request that carries
// next-router-prefetch: 1. Next would render it as a router prefetch, which
// throws on the server; no real client sends it, so it is answered as missing.
// Middleware has already run on the original path, so the flag and auth gates
// apply first.
export function GET(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

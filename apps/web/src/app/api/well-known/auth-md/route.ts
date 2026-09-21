import { buildAuthMd } from '@/lib/agent-auth/auth-md';
import { agentIssuer, isAgentDoorOpen } from '@/lib/agent-auth/door';

// The document depends on runtime env config (issuer, deployment mode), not build-time state.
export const dynamic = 'force-dynamic';

// Rewritten to from `/auth.md` (lib/well-known/rewrites.ts, applied in middleware
// and next.config beforeFiles). The agent-registration recipe (ADR 0007 Decision
// 12): public by design — it is what an agent reads before it has any identity —
// and built purely from the configured issuer, never a request Host header
// (threat model T14), which is why the handler takes no request at all. On a
// deployment where the agent door is closed the recipe would describe endpoints
// that answer 404, so it answers 404 too.
export async function GET(): Promise<Response> {
  if (!isAgentDoorOpen()) {
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  return new Response(buildAuthMd({ issuer: agentIssuer() }), {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

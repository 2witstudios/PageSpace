import { buildLlmsTxt } from '@/lib/agent-auth/llms-txt';
import { agentIssuer, isAgentDoorOpen } from '@/lib/agent-auth/door';

// The document depends on runtime env config (issuer, deployment mode), not build-time state.
export const dynamic = 'force-dynamic';

// Rewritten to from `/llms.txt` (lib/well-known/rewrites.ts). The first thing an
// AI agent reads on a site: what PageSpace is and — when the agent door is open —
// that the agent may create an account of its own and where `/auth.md` is.
// Public, built only from the configured issuer (never a request Host header,
// threat model T14), so the handler takes no request at all.
export async function GET(): Promise<Response> {
  return new Response(buildLlmsTxt({ issuer: agentIssuer(), agentSignupOpen: isAgentDoorOpen() }), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

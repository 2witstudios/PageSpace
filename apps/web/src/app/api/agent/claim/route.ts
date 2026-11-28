/**
 * POST /api/agent/claim — an agent asks to be claimed (ADR 0008 Decisions 3,
 * 8; auth.md "Fund"; security review addendum). The caller proves it IS the
 * agent with its own `pagespace-agent` access token as Bearer — there is no
 * claim token any more: a second secret that could start a claim (and so hand
 * ownership, and the secret rotation ownership allows, to whoever held it) was
 * an agent-takeover credential. The answer is a short user code a HUMAN enters
 * at `/claim` while the agent polls the claim grant on `/api/oauth/token` with
 * the same Bearer.
 *
 * Controls live in `handleOwnClaimStart`: the deployment gate (closed → 404),
 * the per-IP AGENT_CLAIM_INIT limit, the agent's own credential (anyone else
 * → 404), an empty body (a `claim_token` → 400), AGENT_CLAIM_INIT per agent,
 * then the start. A store failure is a constant 503.
 */
import { handleOwnClaimStart } from '@/lib/agent-auth/claim-start-handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleOwnClaimStart(request, 'bearer');
}

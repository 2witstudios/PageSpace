/**
 * POST /api/agent/claim/session — an AI agent signed in by SESSION asks for a
 * claim link to hand a human (Agent Signup Phase 3: the unfunded banner's
 * "share your claim link", the Settings identity card's "Copy claim link", the
 * post-signup reveal card).
 *
 * The bearer door's twin (`POST /api/agent/claim` with the agent's own access
 * token): here the agent's browser session is the proof — SESSION only (never
 * a bearer — an OAuth grant the agent gave another client must not start
 * claims), CSRF enforced, the caller must be the agent itself
 * (`resolveClaimCaller`), AGENT_CLAIM_INIT per agent. Same handler and response
 * shape as the bearer door, so `/claim?user_code=` is the one human page.
 */
import { handleOwnClaimStart } from '@/lib/agent-auth/claim-start-handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleOwnClaimStart(request, 'session');
}

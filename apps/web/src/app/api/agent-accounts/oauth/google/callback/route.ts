import { handleAgentAccountGoogleCallback } from '@/lib/agent-accounts/google-enrollment-callback';

/** GET /api/agent-accounts/oauth/google/callback — where Google returns a person connecting an agent's account (once registered on the OAuth client). */
export async function GET(request: Request) {
  return handleAgentAccountGoogleCallback(request);
}

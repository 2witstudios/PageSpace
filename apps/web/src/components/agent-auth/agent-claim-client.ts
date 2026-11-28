import { post } from '@/lib/auth/auth-fetch';

/** What `POST /api/agent/claim/session` returns: the link a human opens to claim and fund this agent. */
export interface AgentClaimLink {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Ask for a fresh claim link for the signed-in agent (session + CSRF via auth-fetch). */
export function requestAgentClaimLink(): Promise<AgentClaimLink> {
  return post<AgentClaimLink>('/api/agent/claim/session');
}

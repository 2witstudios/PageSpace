import type { AgentAuthMode } from '@/components/agent-auth/AgentAuthLink';

type ErrorBody = { error?: string; retryAfter?: number };

export function modeFromParam(value: string | null): AgentAuthMode {
  return value === 'signin' ? 'signin' : 'signup';
}

/** The copy shown for a refused request; never echoes server internals. */
export function describeAgentAuthError(status: number, body: ErrorBody, mode: AgentAuthMode): string {
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60));
    return `Too many attempts from this network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  if (status === 403 && body.error === 'invalid_csrf') return 'This form expired. Try again.';
  if (status === 404) return 'Agent accounts are not available on this PageSpace.';
  if (mode === 'signin') {
    return status === 401 ? 'That agent secret was not accepted.' : 'Could not sign in. Try again.';
  }
  if (status === 403 && body.error === 'pow_invalid') return 'The proof of work was not accepted. Try again.';
  return 'Could not create the agent account. Try again.';
}

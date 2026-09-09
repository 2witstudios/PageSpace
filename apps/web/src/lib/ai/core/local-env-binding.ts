/**
 * Is this conversation's bound session on a LOCAL environment? (GA wave 2)
 *
 * The `request_env_approval` tool is injected at route level ONLY when the
 * answer is yes: a Sprite session can never produce a `local_approval_required`
 * result, so advertising the tool there would only invite a call that has
 * nothing to answer. The lookup is the same one the sandbox eligibility gate
 * makes (the session a conversation is bound to), then the env row's
 * substrate. Any failure — no session, no env, a Sprite env, a lookup error —
 * is "not local": the tool is simply not offered, never offered by default.
 */
export interface LocalEnvBinding {
  readonly envId: string;
}

export interface LocalEnvBindingDeps {
  readonly findSessionForConversation: (conversationId: string) => Promise<{ envId: string | null } | null>;
  readonly findEnv: (envId: string) => Promise<{ substrate: string } | null>;
}

export async function resolveLocalEnvBinding(conversationId: string | undefined, deps: LocalEnvBindingDeps): Promise<LocalEnvBinding | null> {
  if (!conversationId) return null;
  try {
    const session = await deps.findSessionForConversation(conversationId);
    if (!session || session.envId === null) return null;
    const env = await deps.findEnv(session.envId);
    if (!env || env.substrate !== 'local') return null;
    return { envId: session.envId };
  } catch {
    return null;
  }
}

/** The production binding: the agent-session store and the drive-env store, both loaded lazily (the chat pipeline must not import them at module load). */
export async function resolveLocalEnvBindingForConversation(conversationId: string | undefined): Promise<LocalEnvBinding | null> {
  return resolveLocalEnvBinding(conversationId, {
    findSessionForConversation: async (id) => {
      const { findSessionForConversation } = await import('@/lib/agent-workspaces/agent-workspaces-runtime');
      return findSessionForConversation(id);
    },
    findEnv: async (envId) => {
      const { getDriveEnvStore } = await import('@/lib/drive-envs/drive-envs-runtime');
      return (await getDriveEnvStore()).findById(envId);
    },
  });
}

/**
 * The Tier B tool, injected ONCE for both chat turns (the turn-duplication
 * ratchet forbids copying it). With the same discipline as `ask_user`: after
 * every transform, never in `tool_search` / `execute_tool` — and ONLY when the
 * bound session is on a local environment. Returns the tools to use and the
 * names the turn must pause on (ask_user always; the approval tool when injected).
 */
export async function withEnvApprovalTool<T extends Record<string, unknown>>(
  tools: T,
  conversationId: string | undefined,
): Promise<{ tools: T; pauseToolNames: string[]; injected: boolean }> {
  const { ASK_USER_TOOL_NAME } = await import('@/lib/ai/tools/ask-user-tools');
  const pauseToolNames = [ASK_USER_TOOL_NAME];
  const binding = await resolveLocalEnvBindingForConversation(conversationId);
  if (binding === null) return { tools, pauseToolNames, injected: false };
  const { envApprovalTools, REQUEST_ENV_APPROVAL_TOOL_NAME } = await import('@/lib/ai/tools/env-approval-tools');
  pauseToolNames.push(REQUEST_ENV_APPROVAL_TOOL_NAME);
  return { tools: { ...tools, ...envApprovalTools } as T, pauseToolNames, injected: true };
}

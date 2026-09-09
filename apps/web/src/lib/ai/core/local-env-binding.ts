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

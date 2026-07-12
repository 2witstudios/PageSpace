/**
 * The live assistant messageId of EACH of a surface's chats, kept strictly apart.
 *
 * GlobalAssistantView hosts two independent chats — the agent one and the global one — and both
 * can be in flight at the same time: switching mode does NOT abort the running POST, because
 * useChat's `id` is a constant and the Chat is never recreated.
 *
 * The component used to derive ONE id from the mode-selected `status`/`messages` (correct for
 * what it renders) and feed that single value into BOTH stream-identity hold-refs. So while the
 * global stream sat in 'submitted' with no id of its own, the agent's id became the mode-selected
 * value — and the global ref latched it and pinned it for the rest of the stream. Stop, back in
 * global mode, then aborted the AGENT's stream: that answer died mid-sentence while the global
 * generation kept running its write tools and kept billing, its own Stop permanently wired to an
 * id that was never its.
 *
 * This exists as a pure function because the bug was in the WIRING, not in the reducer it fed.
 * A test of `holdForStream` alone passes happily while the caller hands it the wrong chat's id —
 * which is exactly what happened. Making the wiring itself the unit under test is the only way to
 * pin it.
 *
 * Both ids resolve ONLY at `status === 'streaming'`, never 'submitted': useChat sets 'submitted'
 * before issuing the request and pushes the new assistant message inside write(), which flips the
 * status in the same job — so during 'submitted' the array's last assistant message is the
 * PREVIOUS turn's reply. Returning undefined there is correct; callers fall back to the chatId
 * map. See holdForStream's caller contract.
 */

interface ChatSnapshot {
  status: string;
  messages: ReadonlyArray<{ id: string; role: string }>;
}

const lastAssistantIdWhileStreaming = ({ status, messages }: ChatSnapshot): string | undefined => {
  if (status !== 'streaming') return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id;
  }
  return undefined;
};

export const selectLiveAssistantIds = ({
  agent,
  global,
}: {
  agent: ChatSnapshot;
  global: ChatSnapshot;
}): { agentLiveId: string | undefined; globalLiveId: string | undefined } => ({
  // Each id is computed from ITS OWN chat's status and messages. Neither function argument can
  // reach the other's result — that separation is the entire contract.
  agentLiveId: lastAssistantIdWhileStreaming(agent),
  globalLiveId: lastAssistantIdWhileStreaming(global),
});

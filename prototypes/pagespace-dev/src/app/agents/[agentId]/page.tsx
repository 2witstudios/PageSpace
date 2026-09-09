import AgentDetail from "@/components/agent/AgentDetail";

/** Next 16: params is a Promise — always await it (repo rule). */
export default async function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return <AgentDetail agentId={agentId} />;
}

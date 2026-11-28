import type { Metadata } from "next";
import { AgentDoorProvider } from "@/components/agent-auth/AgentDoorContext";
import { isAgentDoorOpen } from "@/lib/agent-auth/door";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // The agent door (ADR 0008 Decision 11) is decided here, on the server, per request:
  // onprem opens it with the runtime AGENT_SIGNUP_ENABLED flag the client cannot read.
  return <AgentDoorProvider open={isAgentDoorOpen()}>{children}</AgentDoorProvider>;
}

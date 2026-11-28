'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Whether the agent signup door is open on this deployment (ADR 0008 Decision
 * 11), decided ON THE SERVER by `isAgentDoorOpen()` in the auth layout and
 * handed to the client pages — the client cannot read `AGENT_SIGNUP_ENABLED`,
 * and an onprem operator flips it at runtime. Defaults to closed, so a page
 * rendered without the provider shows no agent links.
 */
const AgentDoorContext = createContext(false);

export function AgentDoorProvider({ open, children }: { open: boolean; children: ReactNode }) {
  return <AgentDoorContext.Provider value={open}>{children}</AgentDoorContext.Provider>;
}

export function useAgentDoorOpen(): boolean {
  return useContext(AgentDoorContext);
}

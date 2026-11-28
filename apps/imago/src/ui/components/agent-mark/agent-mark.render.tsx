import type { ReactNode } from 'react';
import { isAgentAccount } from '@pagespace/lib/auth/agent/display-name';
import { badgeClass } from '../badge/badge-class';
import { renderIcon } from '../icon/icon.render';

export type AgentMarkProps = {
  /** `users.accountType` of the person whose name this sits beside. */
  readonly accountType?: string | null;
};

const TITLE = 'AI agent account: its name is self-chosen, not a verified identity';

/**
 * Imago's agent marker (Agent Signup Phase 2c), the counterpart of classic's
 * `AgentBadge`. An agent picks its own display name, so the marker comes from
 * `accountType`, never from the name. Renders nothing for a human.
 */
export function renderAgentMark({ accountType }: AgentMarkProps): ReactNode {
  if (!isAgentAccount(accountType)) return null;
  return (
    <span className={badgeClass('neutral')} title={TITLE} aria-label="AI agent account">
      {renderIcon({ name: 'bot', size: 12 })}
      Agent
    </span>
  );
}

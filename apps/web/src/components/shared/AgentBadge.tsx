import { Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { isAgentAccount } from '@pagespace/lib/auth/agent/display-name';

/**
 * Rendered beside a name wherever it belongs to an AI agent account (Agent
 * Signup Phase 2b). An agent picks its own display name, so "PageSpace Support"
 * can be anyone: the marker comes from `accountType`, never from the name.
 * Renders nothing for a human.
 */
export function AgentBadge({ accountType, className }: { accountType?: string | null; className?: string }) {
  if (!isAgentAccount(accountType)) return null;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 px-1.5 py-0 text-[10px] font-normal shrink-0', className)}
      title="AI agent account: its name is self-chosen, not a verified identity"
      aria-label="AI agent account"
    >
      <Bot className="h-3 w-3" aria-hidden="true" />
      Agent
    </Badge>
  );
}

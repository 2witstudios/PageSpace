import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/mock/types";

const DOT: Record<AgentStatus, string> = {
  running: "bg-success",
  // Waiting is the attention state — it pulses (DESIGN.md §5).
  waiting: "bg-warning status-pulse",
  broken: "bg-destructive",
  benched: "bg-muted-foreground/50",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: "Running",
  waiting: "Waiting on input",
  broken: "Broken",
  benched: "Benched",
};

export default function AgentStatusDot({
  status,
  className,
}: {
  status: AgentStatus;
  className?: string;
}) {
  return (
    <span
      title={STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status], className)}
    />
  );
}

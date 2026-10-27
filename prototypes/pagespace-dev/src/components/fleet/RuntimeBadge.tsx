import { Bot, SquareTerminal, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentRuntime } from "@/lib/mock/types";

const RUNTIME: Record<AgentRuntime, { label: string; icon: React.ElementType }> = {
  claude: { label: "Claude", icon: Sparkles },
  codex: { label: "Codex", icon: Bot },
  terminal: { label: "Terminal", icon: SquareTerminal },
};

export default function RuntimeBadge({
  runtime,
  className,
}: {
  runtime: AgentRuntime;
  className?: string;
}) {
  const { label, icon: Icon } = RUNTIME[runtime];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}

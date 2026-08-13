import { cn } from "@/lib/utils";
import type { DiffStat } from "@/lib/mock/types";

export default function DiffStatChip({
  diff,
  className,
}: {
  diff: DiffStat;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px] leading-none", className)}>
      <span className="text-success">+{diff.additions}</span>
      <span className="text-destructive">−{diff.deletions}</span>
      <span className="text-muted-foreground">
        · {diff.files} {diff.files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

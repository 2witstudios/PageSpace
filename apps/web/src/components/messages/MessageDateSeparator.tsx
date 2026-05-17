export function MessageDateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-3 px-2">
      <div className="flex-1 h-px bg-border" />
      <span className="text-xs text-muted-foreground bg-background px-2 py-0.5 rounded-full border border-border whitespace-nowrap">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

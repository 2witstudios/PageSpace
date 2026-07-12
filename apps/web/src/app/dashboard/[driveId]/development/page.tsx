import { SquareTerminal } from 'lucide-react';

/**
 * The Development surface with no machine selected. The sidebar (the surface's
 * actual content — the aggregated machine tree) lives above this route in
 * `MemoizedSidebar`, so this is only the detail pane's resting state.
 */
export default function DevelopmentPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <SquareTerminal className="size-10 text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold">Select a machine</h2>
        <p className="text-sm text-muted-foreground">
          Pick a machine from the sidebar to open its terminals, code, and diffs.
        </p>
      </div>
    </div>
  );
}

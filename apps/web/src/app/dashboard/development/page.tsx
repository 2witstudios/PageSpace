import { SquareTerminal } from 'lucide-react';

/**
 * The GLOBAL Development surface with no machine selected — every drive's
 * machines, aggregated (see `layout.tsx` for the detail region and
 * `DevelopmentSidebar`'s global mode for the aggregated tree). The sidebar is
 * the surface's actual content; this is only the detail pane's resting state.
 *
 * NOT a redirect to a resolved drive (that was the bug this route used to
 * have) — this driveless entry is itself a real view, the global twin of
 * `/dashboard/{driveId}/development`'s empty state.
 */
export default function GlobalDevelopmentPage() {
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

"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ChevronsUpDown, Folder, Home } from "lucide-react";

import DriveSwitcherDialog from "@/components/layout/navbar/DriveSwitcherDialog";
import { useDriveStore } from "@/hooks/useDrive";

const DASHBOARD_PATH = "/dashboard";

/**
 * Home is the ONE outlined control in the header, at icon-button height
 * (h-9, matching `Button size="icon"`), with the house at the icons' own
 * 20px so it does not read as a smaller, dimmer cousin of its neighbours.
 * The outline is the tell that this is the destination; the drive crumb
 * beside it stays a ghost because it is context.
 */
const HOME_CLASS =
  "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 pl-2 text-sm font-medium";

const DRIVE_CRUMB_CLASS =
  "hidden h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:inline-flex";

/**
 * The header's route home, and the only place the header says where you
 * currently are.
 *
 * "Home", not "Dashboard": the dashboard is becoming the home drive, and a
 * four-letter word is what lets this control keep its word on a 375px phone
 * with every other control still in the row. The house glyph that #2592
 * removed comes back with it — the old objection (the sidebar's "Drive Home"
 * uses a house too) dissolves once the dashboard IS home.
 *
 * The shape follows the route rather than the drive id, because "is a drive
 * open" and "am I on the dashboard" are different questions: /dashboard/dms
 * and its ten static siblings carry no driveId while still being somewhere
 * you need a way out of.
 */
export default function DashboardCrumb() {
  const pathname = usePathname();
  const params = useParams<{ driveId?: string | string[] }>();
  const [pickerOpen, setPickerOpen] = useState(false);

  const rawDriveId = params?.driveId;
  const driveId = Array.isArray(rawDriveId) ? rawDriveId[0] : rawDriveId;

  // The NAME is the only thing taken from the store, and it is allowed to be
  // missing. Drives load asynchronously; a control whose whole job is being
  // the way out must never wait on a fetch to become reachable.
  const driveName = useDriveStore((state) =>
    driveId ? state.drives.find((drive) => drive.id === driveId)?.name : undefined
  );

  if (pathname === DASHBOARD_PATH) {
    // Hidden below lg, unlike the link. This variant is orientation only —
    // there is nowhere for it to go — so it can yield header space without
    // withholding the answer the control exists to give. It keeps the box so
    // the slot holds its shape, but the border drops to the separator colour
    // and the text goes muted: visibly not a button.
    return (
      <span
        aria-current="page"
        className={`${HOME_CLASS} hidden border-[var(--separator)] text-muted-foreground lg:inline-flex`}
      >
        <Home className="h-5 w-5" aria-hidden="true" />
        Home
      </span>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {/*
        No aria-label: the visible text is the accessible name, and an
        aria-label would silently override the thing we just made visible.
      */}
      <Link
        href={DASHBOARD_PATH}
        className={`${HOME_CLASS} border-border bg-card text-foreground transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`}
      >
        <Home className="h-5 w-5" aria-hidden="true" />
        Home
      </Link>

      {/*
        Context AND the drive switcher, so it yields before the label does.

        Gated at lg, not sm, which is the counter-intuitive part: this row gets
        TIGHTER as the viewport grows, because growing is what adds its
        expensive occupants. Going up, NavButtons appears at sm, InlineSearch
        at md with a 200px minimum, and CreditBalance unfolds at sm from a bare
        readout into a readout plus an upgrade and a buy-credits button. md is
        therefore a worse place for a crumb than a phone is. lg is the first
        width where the row is not still gaining occupants.

        Below lg the sidebar is a sheet, and its DriveSwitcher opens the same
        picker, so nothing is lost there but the persistent name.
      */}
      {driveName ? (
        <>
          <span aria-hidden="true" className="hidden px-0.5 text-sm text-muted-foreground/60 lg:inline">
            /
          </span>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            className={DRIVE_CRUMB_CLASS}
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/*
              title + a width cap, matching content-header/Breadcrumbs.tsx: a
              truncated name is unrecoverable without the tooltip, and an
              uncapped one competes with the search field for the same row.
            */}
            <span className="max-w-[160px] truncate" title={driveName}>
              {driveName}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          <DriveSwitcherDialog open={pickerOpen} onOpenChange={setPickerOpen} />
        </>
      ) : null}
    </div>
  );
}

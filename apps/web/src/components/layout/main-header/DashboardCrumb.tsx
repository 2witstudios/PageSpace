"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ChevronsUpDown, Folder, LayoutGrid } from "lucide-react";

import DrivePickerDialog from "@/components/layout/navbar/DrivePickerDialog";
import { useDriveStore } from "@/hooks/useDrive";

const DASHBOARD_PATH = "/dashboard";

/**
 * Ghost, like every other control in this header: `Button` variant="ghost"
 * size="sm" without the component, because one of the two renderings is a
 * Link. The bordered card it replaced was the only outlined thing in the row.
 */
const GHOST_CLASS =
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * The header's route back to the dashboard, and the only place the header
 * says where you currently are.
 *
 * What this replaced was a house glyph followed by a bare "/". The word
 * "Dashboard" lived only in that link's aria-label, so the people who were
 * lost were exactly the ones who could not read it — and the house already
 * means "this drive's home page" one surface over, where PrimaryNavigation
 * labels the same slot "Drive Home" whenever a drive is open. LayoutGrid is
 * the dashboard's own glyph here, on the link and on the marker alike, so
 * the same shape means the same place whether you are on it or heading to it.
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
    // there is nowhere for it to go — so it is a part of this control that can
    // yield header space without withholding the answer the control exists to
    // give. The link variant, which IS the way out, never hides.
    return (
      <span
        aria-current="page"
        className="hidden h-8 shrink-0 items-center gap-1.5 px-2 text-sm font-medium text-foreground lg:flex"
      >
        <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Dashboard
      </span>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {/*
        No aria-label: the visible text is the accessible name, and an
        aria-label would silently override the thing we just made visible.
      */}
      <Link href={DASHBOARD_PATH} className={GHOST_CLASS}>
        <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Dashboard
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
            className={`${GHOST_CLASS} hidden min-w-0 lg:inline-flex`}
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
          <DrivePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
        </>
      ) : null}
    </div>
  );
}

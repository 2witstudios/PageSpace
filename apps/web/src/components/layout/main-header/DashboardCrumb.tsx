"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ArrowLeft, Folder, LayoutGrid } from "lucide-react";

import { useDriveStore } from "@/hooks/useDrive";

const DASHBOARD_PATH = "/dashboard";

/**
 * The header's route back to the dashboard, and the only place the header
 * says where you currently are.
 *
 * What this replaced was a house glyph followed by a bare "/". The word
 * "Dashboard" lived only in that link's aria-label, so the people who were
 * lost were exactly the ones who could not read it — and the house already
 * means "this drive's home page" one surface over, where PrimaryNavigation
 * labels the same slot "Drive Home" whenever a drive is open. The glyph
 * therefore pointed at the wrong idea even when it was noticed. LayoutGrid
 * here leaves the house to the drive home page it already belongs to.
 *
 * The shape follows the route rather than the drive id, because "is a drive
 * open" and "am I on the dashboard" are different questions: /dashboard/dms
 * and its ten static siblings carry no driveId while still being somewhere
 * you need a way out of.
 */
export default function DashboardCrumb() {
  const pathname = usePathname();
  const params = useParams<{ driveId?: string | string[] }>();

  const rawDriveId = params?.driveId;
  const driveId = Array.isArray(rawDriveId) ? rawDriveId[0] : rawDriveId;

  // The NAME is the only thing taken from the store, and it is allowed to be
  // missing. Drives load asynchronously; a control whose whole job is being
  // the way out must never wait on a fetch to become reachable.
  const driveName = useDriveStore((state) =>
    driveId ? state.drives.find((drive) => drive.id === driveId)?.name : undefined
  );

  if (pathname === DASHBOARD_PATH) {
    return (
      <span
        aria-current="page"
        className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-primary-soft px-2.5 text-sm font-semibold text-foreground"
      >
        <LayoutGrid className="h-4 w-4 text-primary" aria-hidden="true" />
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
      <Link
        href={DASHBOARD_PATH}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Dashboard
      </Link>

      {/*
        Context, not a destination — and the first thing to go when space runs
        out. Below sm the label on the button survives and this does not: a
        drive name is what truncates into nonsense on a phone, and the page
        below the header already names the drive.
      */}
      {driveName ? (
        <>
          <span aria-hidden="true" className="hidden px-0.5 text-sm text-muted-foreground/60 sm:inline">
            /
          </span>
          <span className="hidden min-w-0 items-center gap-1.5 px-2 text-sm font-semibold text-foreground sm:flex">
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{driveName}</span>
          </span>
        </>
      ) : null}
    </div>
  );
}

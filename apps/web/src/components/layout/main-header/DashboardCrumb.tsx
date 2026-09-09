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
    // Hidden below lg, unlike the link. This variant is orientation only —
    // there is nowhere for it to go — so it is a part of this control that can
    // yield header space without withholding the answer the control exists to
    // give. The link variant, which IS the way out, never hides.
    return (
      <span
        aria-current="page"
        className="hidden h-8 shrink-0 items-center gap-2 rounded-lg bg-primary-soft px-2.5 text-sm font-semibold text-foreground lg:flex"
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
        Context, not a destination, so it yields before the label does.

        Gated at lg, not sm, which is the counter-intuitive part: this row gets
        TIGHTER as the viewport grows, because growing is what adds its
        expensive occupants. Going up, NavButtons appears at sm, InlineSearch
        at md with a 200px minimum, and CreditBalance unfolds at sm from a bare
        readout into a readout plus an upgrade and a buy-credits button. md is
        therefore a worse place for a crumb than a phone is. lg is the first
        width where the row is not still gaining occupants.

        The cost is worth naming — DriveSwitcher, the only other chrome saying
        which drive you are in, lives in the sidebar, which is a sheet below lg.
        So below lg the drive's name is nowhere in persistent chrome. The label
        still wins: it is the fix for the bug this control exists for.

        Deliberately not a link to the drive's home page, though a breadcrumb
        ancestor usually would be. It only renders at lg and up, which is
        exactly where the sidebar is a fixed panel rather than a sheet — so
        PrimaryNavigation's "Drive Home" is already on screen, spelled out,
        whenever this is. A second unlabelled route to the same page would buy
        nothing and need its own are-we-already-there branch.
      */}
      {driveName ? (
        <>
          <span aria-hidden="true" className="hidden px-0.5 text-sm text-muted-foreground/60 lg:inline">
            /
          </span>
          <span className="hidden min-w-0 items-center gap-1.5 px-2 text-sm font-semibold text-foreground lg:flex">
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/*
              title + a width cap, matching content-header/Breadcrumbs.tsx: a
              truncated name is unrecoverable without the tooltip, and an
              uncapped one competes with the search field for the same row.
            */}
            <span className="max-w-[160px] truncate" title={driveName}>
              {driveName}
            </span>
          </span>
        </>
      ) : null}
    </div>
  );
}

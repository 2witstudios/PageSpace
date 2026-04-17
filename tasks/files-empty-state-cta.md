# Files Empty-State CTA Epic

**Status**: ✅ COMPLETED (2026-04-17)
**Goal**: Give users a discoverable path to upload or create content when the Files view is empty.

## Overview

Landing on an empty Files view with only a folder icon and "No pages in this drive" leaves first-run users stranded — the only affordance is the tiny '+' in the sidebar, which Eric Elliott's feedback flagged as invisible. This epic replaces the inert block in `FilesFinderContent` with a drop zone plus primary Upload and Create actions (reusing `CreatePageDialog`), gates CTAs on the user's drive role so non-members see an explanatory read-only state, and adds co-located tests for rendering, handler wiring, and permission gating.

---

## Empty-State CTA Panel

Replace the empty block in `FilesFinderContent.tsx` with an icon + headline + subheadline + Upload/Create CTA pair, reusing `CreatePageDialog`.

**Requirements**:
- Given a drive role of OWNER or ADMIN (matching the server-side `/api/pages` gate), should render a primary "Upload files" and secondary "Create page" CTA with the subheadline "Upload files or create a page to get started"
- Given a non-owner/non-admin role (MEMBER, or the MEMBER fallback that `drive-service.ts` applies to page-level collaborators), should render a read-only message instead of CTAs that would 403
- Given the Create page button is clicked, should open `CreatePageDialog` seeded with the current driveId and `currentPageId` as parentId
- Given a nested folder is the current location, should pass `currentPageId` through as `parentId` so new pages land in the right parent

---

## Drag-and-Drop Upload Zone

Make the empty panel itself a drop target, wired to `POST /api/upload`.

**Requirements**:
- Given a file is dragged over the empty panel, should show a dashed-outline drop-zone cue
- Given files are dropped, should upload each one via `POST /api/upload` with the current driveId and parentId, and refresh the tree on success
- Given the user is not OWNER/ADMIN on the drive, should not accept drops and the read-only message should remain
- Given an upload is in flight, should register a `form`-type session with `useEditingStore` to prevent SWR from clobbering, and end the session on settle
- Given an upload fails, should surface the server error via `toast.error` without dropping the rest of the batch

---

## Test Coverage

Co-located `__tests__` alongside `FilesFinderContent.tsx` covering the three branches.

**Requirements**:
- Given a non-writable drive role for the current user, should render the read-only message and neither CTA
- Given an OWNER or ADMIN role, should render both CTAs, wire Create to dialog open state, and wire Upload to the hidden file input
- Given a drop event with two files, should call the upload handler twice with the expected driveId and parentId

# Integration: Next.js App Router

This document outlines how pagespace is built using the Next.js App Router, covering our conventions for routing, layouts, API routes, and authentication.

## File-based Routing and Layouts

Our entire web application in [`apps/web`](apps/web) is built on the App Router paradigm.

-   **Directory Structure:** Routes are defined by the directory structure within `apps/web/src/app`. For example, the route `/dashboard/[driveId]/[pageId]` is implemented by the component at [`apps/web/src/app/dashboard/[driveId]/[pageId]/page.tsx`](apps/web/src/app/dashboard/[driveId]/[pageId]/page.tsx:1).
-   **Layouts:** We use `layout.tsx` files to create shared UI that wraps child pages. A key example is [`apps/web/src/app/dashboard/[driveId]/layout.tsx`](apps/web/src/app/dashboard/[driveId]/layout.tsx:1), which creates the main three-panel dashboard view (left sidebar, center panel, right sidebar).
-   **Client Components:** Our primary layouts are client components (`"use client"`) because they manage complex, interactive state for the sidebars and other UI elements.

## API Routes

All backend logic is handled by Next.js API Routes, which are defined in `route.ts` files within the `app/api` directory.

### CRITICAL: Next.js 15 `params` are a Promise

We are using Next.js 15, which introduced a significant change to how dynamic route parameters are accessed. The `params` object is now a `Promise` and **must be awaited**.

**Correct Usage:**
```typescript
// apps/web/src/app/api/pages/[pageId]/route.ts

export async function GET(req: Request, context: { params: Promise<{ pageId: string }> }) {
  // Must await the context.params promise before accessing parameters
  const { pageId } = await context.params;

  // ... rest of the function
}
```

Forgetting to `await context.params` will result in `pageId` being a Promise, not a string, which will cause runtime errors.

### API Route Conventions

-   All API routes should be `async` functions.
-   All API routes must return a `NextResponse` object (e.g., `NextResponse.json(...)`).
-   Authentication is handled by the middleware, but individual routes are still responsible for checking user-specific permissions for the requested resource (e.g., checking if a user has access to a specific page).

## Authentication and Middleware

Route protection is handled centrally by our Next.js middleware.

-   **Location:** [`apps/web/middleware.ts`](apps/web/middleware.ts:1)
-   **Matcher:** The `config.matcher` is configured to run the middleware on every request *except* for static files (`_next/static`, `_next/image`), the favicon, and the authentication pages themselves (`/auth/...`).
-   **Logic:**
    1.  The middleware extracts the `accessToken` from the request's cookies.
    2.  If no token exists, it redirects the user to `/auth/signin`.
    3.  If a token exists, it uses our shared `decodeToken` function (from `@pagespace/lib`) to validate it.
    4.  If the token is invalid or expired, it redirects to `/auth/signin`.
    5.  If the token is valid, it allows the request to proceed to the requested page or API route using `NextResponse.next()`.

## Data Fetching

-   **Server Components:** We fetch data directly in Server Components where possible to improve performance.
-   **Client Components:** All data fetching in Client Components is handled by our custom SWR hooks. See the [SWR integration documentation](swr.md) for more details.
**Last Updated:** 2025-08-13
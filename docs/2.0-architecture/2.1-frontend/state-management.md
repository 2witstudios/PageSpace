# Frontend State Management Architecture

**Last Updated:** 2025-08-21

This document provides a definitive guide to the frontend state management system in this application. It is designed to be the single source of truth for understanding how application data and UI state are fetched, cached, managed, and displayed.

## 1. Core Architectural Principles

Our architecture is built on a **server-centric** model for data, with a clear separation between three types of client-side state.

- **Server State (The Truth):** All core data (pages, drives, users) resides in the database. SWR is our primary tool for fetching, caching, and revalidating this server state. The database is the ultimate source of truth.
- **Application State (Pointers):** These are simple Zustand stores that hold pointers to the user's current context, such as the active drive and page. They don't hold the data itself, but rather the IDs that other hooks use to fetch the data.
- **UI State (The "Look and Feel"):** This is a persisted Zustand store that manages the state of the UI itself—unrelated to the actual data. This includes things like sidebar visibility, which folders are expanded in the navigation tree, and scroll positions.

This separation simplifies logic, improves performance, and ensures a clean distinction between data fetching and user interface presentation.

## 2. The Key Players: Stores and Hooks

### Application State (Zustand Pointers)

These stores answer the question: "What is the user looking at right now?"

#### `usePageStore`

- **Location:** [`apps/web/src/hooks/usePage.ts`](apps/web/src/hooks/usePage.ts)
- **Responsibilities:** Holds the `pageId` of the page the user is currently viewing.
- **Exposed State:**
    - `pageId: string | null`
    - `setPageId(pageId: string | null)`

#### `useDriveStore`

- **Location:** [`apps/web/src/hooks/useDrive.ts`](apps/web/src/hooks/useDrive.ts)
- **Responsibilities:** Holds the `driveId` of the drive the user is currently in and manages the list of available drives.
- **Exposed State:**
    - `currentDriveId: string | null`
    - `drives: Drive[]`
    - `isLoading: boolean`
    - `lastFetched: number`
    - `setCurrentDrive(driveId: string | null)`
    - `fetchDrives()`
    - `addDrive(drive: Drive)`
- **Notes:** This store implements a 5-minute client-side cache to avoid redundant API calls.

### UI State (Zustand)

This store answers the question: "How has the user configured their interface?"

#### `useUIStore`

This is a critical, persisted Zustand store that manages the overall state of the application's UI, ensuring user preferences are remembered across sessions.

- **Location:** [`apps/web/src/stores/useUIStore.ts`](apps/web/src/stores/useUIStore.ts)
- **Responsibilities:**
    - Manages the open/closed state of the left and right sidebars.
    - Persists the expanded/collapsed state of folders within the `PageTree`.
    - Tracks the scroll position of the `PageTree`.
    - Holds the view type for the center content panel (e.g., 'document', 'folder', 'settings').
- **Exposed State:**
    - `leftSidebarOpen: boolean`
    - `rightSidebarOpen: boolean`
    - `treeExpanded: Set<string>`
    - `toggleLeftSidebar()`, `toggleRightSidebar()`
    - `setTreeExpanded(nodeId: string, expanded: boolean)`
    - `setLeftSidebar(open: boolean)`
    - `setRightSidebar(open: boolean)`
    - `setCenterViewType(viewType: UIState['centerViewType'])`
    - `setNavigating(navigating: boolean)`
    - `setTreeScrollPosition(position: number)`

### Server State (SWR Hooks)

These hooks are responsible for fetching and managing the actual data from the server.

#### `usePageTree`

This hook manages the state and interactions for the page navigation tree in the left sidebar. It's more than just a data fetcher.

- **Location:** [`apps/web/src/hooks/usePageTree.ts`](apps/web/src/hooks/usePageTree.ts)
- **Primary Data Source:** Fetches root pages via `GET /api/drives/[driveId]/pages` or, if in the trash view, `GET /api/drives/[driveId]/trash`.
- **Responsibilities:**
    - Manages the hierarchical display of pages.
    - Handles lazy-loading of children pages when a folder is expanded, using `fetchAndMergeChildren`.
    - Provides an `updateNode` function and exposes the SWR `mutate` function to enable optimistic UI updates. The hook itself does not contain specific create, rename, or delete logic.
    - Manages loading states for individual child nodes (`childLoadingMap`).

#### `useBreadcrumbs`

This hook fetches and displays the breadcrumb navigation for the active page.

- **Location:** [`apps/web/src/hooks/useBreadcrumbs.ts`](apps/web/src/hooks/useBreadcrumbs.ts)
- **Primary Data Source:** Fetches data from `/api/pages/[pageId]/breadcrumbs`.
- **Responsibilities:**
    - Provides the `breadcrumbs` array to the UI.
    - Handles loading and error states for the breadcrumb data.

## 3. The Data Flow in Practice

This is how the components and hooks interact during typical user actions.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant PageTree (Left Sidebar)
    participant MiddleContent
    participant usePageStore
    participant useDriveStore
    participant useUIStore
    participant SWR Hooks (usePageTree, useBreadcrumbs)
    participant API

    User->>PageTree: Clicks on a Page
    PageTree->>useDriveStore: setCurrentDrive("drive-1")
    PageTree->>usePageStore: setPageId("page-5")

    MiddleContent->>usePageStore: Gets "page-5"
    MiddleContent->>SWR Hooks: Trigger fetch for page details

    SWR Hooks->>API: GET /api/pages/page-5
    API-->>SWR Hooks: Returns page data
    SWR Hooks-->>MiddleContent: Provides page data to render

    User->>PageTree: Expands a folder
    PageTree->>useUIStore: setTreeExpanded("folder-id", true)
    PageTree->>SWR Hooks: usePageTree.fetchAndMergeChildren("folder-id")
    
    SWR Hooks->>API: GET /api/pages/folder-id/children
    API-->>SWR Hooks: Returns children
    SWR Hooks-->>PageTree: Merges children into tree data
    PageTree->>User: Renders expanded folder with children
```

### Step-by-Step Breakdown

1.  **Initial Load:** A user navigates to `/dashboard/[driveId]/[pageId]`. The root layout extracts `driveId` and `pageId`.
2.  **State Initialization:** The layout calls `setCurrentDrive()` and `setPageId()` to set the global application pointers.
3.  **Component Rendering & Data Fetching:**
    - The `LeftSidebar` uses `usePageTree` to fetch the navigation tree for the `currentDriveId`. It also uses `useUIStore` to determine which folders should be rendered as expanded.
    - The `MiddleContent` uses the `pageId` from `usePageStore` to fetch the page's content via an SWR hook.
    - The `Breadcrumbs` component uses `useBreadcrumbs` to fetch its data from the API.
4.  **User Clicks a New Page:**
    - The `onClick` handler updates the URL and calls `setPageId()`.
    - This change in `pageId` causes all components subscribed to it to re-render and re-fetch their required data via their respective SWR hooks.
5.  **User Expands a Folder in the Tree:**
    - The `onClick` handler in the `PageTree` calls `setTreeExpanded(folderId, true)` from `useUIStore`. This immediately persists the expanded state.
    - Simultaneously, it calls `fetchAndMergeChildren(folderId)` from `usePageTree`.
    - `usePageTree` fetches the children from the API, and upon success, merges them into the existing SWR cache for the tree, causing the UI to update and show the nested pages.

This architecture provides a robust and scalable system by clearly separating server data from client-side application and UI state, leveraging the strengths of SWR for data caching and Zustand for synchronous state management.
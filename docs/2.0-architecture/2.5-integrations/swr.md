# Integration: SWR

This document outlines how pagespace uses SWR for client-side data fetching.

## Core Concept: Custom Hooks for Data Fetching

SWR is our primary library for fetching, caching, and revalidating data in the Next.js client. Our core convention is to **abstract all SWR-related logic into custom hooks** located in the [`apps/web/src/hooks`](apps/web/src/hooks) directory.

This approach provides several benefits:
-   **Encapsulation:** Components don't need to know the specific API endpoint or how the data is fetched. They simply use a hook (e.g., `useAuth()`) and receive the data, loading state, and error state.
-   **Reusability:** The same data-fetching logic can be easily reused across multiple components.
-   **Consistency:** It establishes a clear and consistent pattern for data fetching across the entire application.

A simple, reusable `fetcher` function is defined in most hooks to handle the actual HTTP request.

```typescript
const fetcher = (url: string) => fetch(url).then(res => res.json());
```

## SWR Usage Patterns & Examples

We use several key SWR patterns throughout the codebase. The following custom hooks serve as excellent examples of these patterns.

### 1. Simple Data Fetching: `useAuth`

The [`useAuth`](apps/web/src/hooks/use-auth.ts:16) hook is a straightforward example of fetching global, user-specific data. It fetches from a static API endpoint (`/api/auth/me`) and returns the user object, loading state, and error state.

```typescript
// apps/web/src/hooks/use-auth.ts
export function useAuth() {
  const { data: user, error, isLoading } = useSWR<User>('/api/auth/me', fetcher);

  return {
    user,
    isLoading,
    isError: error,
    isAuthenticated: !error && !isLoading && !!user,
  };
}
```

### 2. Conditional Fetching: `useBreadcrumbs`

The [`useBreadcrumbs`](apps/web/src/hooks/useBreadcrumbs.ts:6) hook demonstrates **conditional fetching**. The request is only made if a `pageId` is provided. If `pageId` is `null`, the SWR key is `null`, and SWR will not execute the fetch. This is the standard way to handle data that depends on other state.

```typescript
// apps/web/src/hooks/useBreadcrumbs.ts
export function useBreadcrumbs(pageId: string | null) {
  const { data, error } = useSWR(
    pageId ? `/api/pages/${pageId}/breadcrumbs` : null, // The SWR Key
    fetcher
  );
  // ...
}
```

### 3. Advanced Usage: `usePageTree`

The [`usePageTree`](apps/web/src/hooks/usePageTree.ts:38) hook is our most advanced and comprehensive example, showcasing several powerful SWR features.

#### Dynamic SWR Keys

The SWR key (the API endpoint) is constructed dynamically based on the hook's arguments. This allows the same hook to fetch different data, such as the main page tree or the contents of the trash.

```typescript
// apps/web/src/hooks/usePageTree.ts
const swrKey = driveId ? (trashView ? `/api/drives/${encodeURIComponent(driveId)}/trash` : `/api/drives/${encodeURIComponent(driveId)}/pages`) : null;
const { data, error, mutate } = useSWR<TreePage[]>(swrKey, fetcher);
```

#### Manual & Optimistic Updates with `mutate`

We use the `mutate` function returned by `useSWR` to manually update the local cache, providing a faster user experience.

-   **Optimistic Updates:** In `fetchAndMergeChildren`, we optimistically update the tree with the new children data *before* the API call completes. The `false` flag tells SWR not to revalidate the data immediately.
-   **Local Cache Manipulation:** In `updateNode`, we directly manipulate the cached data to reflect a change (like a page rename) without needing to refetch the entire tree.

```typescript
// apps/web/src/hooks/usePageTree.ts
const { mutate } = useSWR<TreePage[]>(swrKey, fetcher);

// Example: Optimistically adding children to the tree
const updatedTree = mergeChildren(currentTree, pageId, children);
mutate(updatedTree, false); // Update local data, don't re-fetch
```

#### Programmatic Cache Invalidation

The `invalidateTree` function shows how to programmatically clear the cache for a specific key and trigger a re-fetch. This is useful after a major operation (like moving a page) where we need to ensure we have the absolute latest state from the server.

```typescript
// apps/web/src/hooks/usePageTree.ts
import { useSWRConfig } from 'swr';

const { cache } = useSWRConfig();

const invalidateTree = useCallback(() => {
  if (swrKey) {
    cache.delete(swrKey); // Invalidate the cache for this key
    mutate();             // Trigger a re-fetch
  }
}, [swrKey, cache, mutate]);
```

## Best Practices for New Developers

1.  **Create a Hook:** When fetching new data, always start by creating a new custom hook in the [`apps/web/src/hooks`](apps/web/src/hooks) directory.
2.  **Keep it Simple:** For most use cases, a simple SWR call with a conditional key is sufficient.
3.  **Use `mutate` for Speed:** For actions that should feel instantaneous (like renaming, creating, or deleting), use `mutate` to update the UI optimistically.
4.  **Invalidate When Necessary:** If you perform an action that has wide-ranging effects, use `cache.delete` and `mutate()` to ensure the UI reflects the correct server state.
**Last Updated:** 2025-08-13
# Integration: Zustand

This document outlines how pagespace uses Zustand for client-side state management.

## Core Concept: Client-Side State Management

Zustand is our chosen library for managing **global client-side state**. We use it for state that needs to be shared across multiple, often unrelated, components without the need to pass props down through many levels of the component tree.

It's important to distinguish its role from SWR:
-   **SWR:** Used for managing *server state*—data that is fetched from our API. It handles caching, revalidation, and synchronization with the backend.
-   **Zustand:** Used for managing *client state*—data that exists only within the user's browser session. This includes UI state (like which sidebar is open), user selections, and other ephemeral data that doesn't have a direct representation in the database.

Our convention is to define each store in its own file within the [`apps/web/src/stores`](apps/web/src/stores) or [`apps/web/src/hooks`](apps/web/src/hooks) directories and expose it as a custom hook.

Currently, the codebase contains **12 Zustand stores** distributed across these directories:
- 9 stores in `apps/web/src/stores/` (primary location for complex state management)
- 3 stores in `apps/web/src/hooks/` (simpler state patterns)

## Zustand Usage Patterns & Examples

We use Zustand to manage various types of state. The following stores are excellent examples of our established patterns.

### 1. Simple UI State: `usePageStore`

-   **Location:** [`apps/web/src/hooks/usePage.ts`](apps/web/src/hooks/usePage.ts:1)
-   **Purpose:** A basic store that holds a single piece of global state: the `pageId` of the currently viewed page. This allows any component in the tree to know which page is active.

```typescript
// apps/web/src/hooks/usePage.ts
export const usePageStore = create<PageState>((set) => ({
  pageId: null,
  setPageId: (pageId) => set({ pageId }),
}));
```

### 2. State with Async Actions: `useDriveStore`

-   **Location:** [`apps/web/src/hooks/useDrive.ts`](apps/web/src/hooks/useDrive.ts:1)
-   **Purpose:** Manages the list of available drives and the currently selected drive.
-   **Pattern:** This store demonstrates how to include async actions (`fetchDrives`) within a store. This action can be called from any component to trigger an API call and update the store's state with the result.

```typescript
// apps/web/src/hooks/useDrive.ts
export const useDriveStore = create<DriveState>((set) => ({
  drives: [],
  currentDriveId: null,
  isLoading: false,
  fetchDrives: async () => {
    set({ isLoading: true });
    const response = await fetch('/api/drives');
    const drives = await response.json();
    set({ drives, isLoading: false });
  },
  // ... other actions
}));
```

### 4. Complex State Management: `useLayoutStore`

-   **Location:** [`apps/web/src/stores/useLayoutStore.ts`](apps/web/src/stores/useLayoutStore.ts:1)
-   **Purpose:** Manages application layout, navigation, and caching strategies.
-   **Pattern:** This demonstrates advanced patterns including selective persistence (only persisting specific fields), sophisticated caching mechanisms, and async navigation actions. It's an excellent example of how Zustand can handle complex application state.

```typescript
// apps/web/src/stores/useLayoutStore.ts
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      // State
      currentPageId: null,
      isNavigating: false,
      navigationCache: new Map(),
      
      // Actions with caching
      navigateToPage: async (pageId: string) => {
        set({ isNavigating: true });
        
        // Check cache first
        const cached = get().navigationCache.get(pageId);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          set({ currentPageId: pageId, isNavigating: false });
          return cached.data;
        }
        
        // Fetch and cache
        const pageData = await fetchPageData(pageId);
        get().navigationCache.set(pageId, { 
          data: pageData, 
          timestamp: Date.now() 
        });
        
        set({ currentPageId: pageId, isNavigating: false });
        return pageData;
      },
    }),
    {
      name: 'layout-storage',
      // Only persist specific fields
      partialize: (state) => ({ 
        currentPageId: state.currentPageId 
      }),
    }
  )
);
```

### 5. Persisted State: `useFavorites`

-   **Location:** [`apps/web/src/hooks/useFavorites.ts`](apps/web/src/hooks/useFavorites.ts:1)
-   **Purpose:** Manages the user's list of favorite pages.
-   **Pattern:** This store uses the **`persist` middleware** from Zustand to automatically save the user's favorites to `localStorage`. This ensures that the user's favorites are not lost when they close or refresh the browser tab.
-   **Advanced Persistence:** It also demonstrates how to use a custom `reviver` and `replacer` with `createJSONStorage` to correctly handle complex data types like `Set`, which are not natively supported by JSON.

```typescript
// apps/web/src/hooks/useFavorites.ts
export const useFavorites = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: new Set(),
      // ... actions
    }),
    {
      name: 'favorites-storage', // The key in localStorage
      storage: createJSONStorage(() => localStorage, {
        // Custom logic to convert Set -> Array for JSON
        replacer: (key, value) => {
          if (key === 'favorites' && value instanceof Set) {
            return Array.from(value);
          }
          return value;
        },
        // Custom logic to convert Array -> Set from JSON
        reviver: (key, value) => {
          if (key === 'favorites' && Array.isArray(value)) {
            return new Set(value);
          }
          return value;
        },
      }),
    }
  )
);
```

### 6. Authentication State: `useAuthStore`

-   **Location:** [`apps/web/src/stores/auth-store.ts`](apps/web/src/stores/auth-store.ts:1)
-   **Purpose:** Manages user authentication state, session management, and user preferences.
-   **Pattern:** This store demonstrates complex authentication patterns with persistence, including secure session handling, user data caching, and authentication status tracking.

### 7. Real-time Socket Management: `useSocketStore`

-   **Location:** [`apps/web/src/stores/socketStore.ts`](apps/web/src/stores/socketStore.ts:1)
-   **Purpose:** Manages Socket.IO connection state and reconnection logic.
-   **Pattern:** Shows how to integrate WebSocket connections with Zustand, handling connection states, automatic reconnection, and event subscription management.

### 8. Document Management: `useDocumentManagerStore`

-   **Location:** [`apps/web/src/stores/useDocumentManagerStore.ts`](apps/web/src/stores/useDocumentManagerStore.ts:1)
-   **Purpose:** Advanced document state management with Maps and Sets.
-   **Pattern:** Demonstrates handling complex data structures like Maps for document instances and Sets for tracking open documents, along with sophisticated state synchronization.

### 9. Notification System: `useNotificationStore`

-   **Location:** [`apps/web/src/stores/notificationStore.ts`](apps/web/src/stores/notificationStore.ts:1)
-   **Purpose:** Manages application notifications with Socket.IO integration.
-   **Pattern:** Shows how to combine Zustand with real-time events, managing notification queues, toast messages, and real-time updates from the server.

### 10. UI State Management: `useUIStore`

-   **Location:** [`apps/web/src/stores/useUIStore.ts`](apps/web/src/stores/useUIStore.ts:1)
-   **Purpose:** Manages global UI state like sidebar visibility, theme preferences, and modal states.
-   **Pattern:** Uses persistence with Set serialization for managing collections of UI states, similar to the favorites pattern but for UI preferences.

## Additional Store Examples

The codebase also includes several other specialized stores:

- **`useDocumentStore`** ([`apps/web/src/stores/useDocumentStore.ts`](apps/web/src/stores/useDocumentStore.ts:1)): Basic document editing with auto-save
- **`useDirtyStore`** ([`apps/web/src/stores/useDirtyStore.ts`](apps/web/src/stores/useDirtyStore.ts:1)): Tracks unsaved changes in documents
- **`useEditingStore`** ([`apps/web/src/stores/useEditingStore.ts`](apps/web/src/stores/useEditingStore.ts:1)): Tracks active editing/streaming state for UI refresh protection

## Best Practices for New Developers

1.  **Identify the State Type:** Before creating a store, determine if you are managing server state or client state. If it comes from an API, use SWR. If it's purely client-side, use Zustand.
2.  **One Store Per Domain:** Create a new store for each distinct "domain" or "feature" of the application.
3.  **Use the `persist` Middleware:** If the state needs to be remembered across browser sessions, use the `persist` middleware.
4.  **Consider Selective Persistence:** Use the `partialize` option to persist only specific fields when full state persistence isn't needed (see `useLayoutStore`).
5.  **Handle Complex Data Types:** When persisting Sets, Maps, or other non-JSON types, use custom `replacer` and `reviver` functions (see `useFavorites`).
6.  **Integrate with Real-time Systems:** Zustand works well with Socket.IO for real-time features (see `useNotificationStore` and `useSocketStore`).

## Common Patterns in the Codebase

- **Persistence with localStorage**: Most UI-related stores use the `persist` middleware
- **Async Actions**: Many stores include async actions for API calls (see `useDriveStore`)
- **Caching Strategies**: Complex stores implement caching for performance (see `useLayoutStore`)
- **State Composition**: Larger features may use multiple related stores working together
- **Type Safety**: All stores are fully typed with TypeScript interfaces

**Last Updated:** 2025-08-21
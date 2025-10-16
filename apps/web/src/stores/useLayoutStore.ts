import { create } from 'zustand';
import { patch, fetchWithAuth } from '@/lib/auth-fetch';
import { persist } from 'zustand/middleware';
import { getLayoutViewType, PageType } from '@pagespace/lib/client-safe';
import { toast } from 'sonner';
import { createClientLogger } from '@/lib/logging/client-logger';

// Types
export interface DocumentState {
  id: string;
  content: string;
  isDirty: boolean;
  version: number;
  lastSaved: number;
  saveTimeout?: NodeJS.Timeout;
}

export interface ViewState {
  viewType: 'document' | 'folder' | 'channel' | 'ai' | 'settings';
  document: DocumentState | null;
  scrollPosition: number;
  timestamp: number;
}

export interface NavigateOptions {
  skipSaveCheck?: boolean;
  force?: boolean;
  preloadAdjacent?: boolean;
}

interface LayoutState {
  // Navigation state
  activePageId: string | null;
  activeDriveId: string | null;
  navigationHistory: string[];
  
  // UI panels state (PERSISTED)
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  
  // Tree state (PERSISTED)
  treeExpanded: Set<string>;
  treeScrollPosition: number;
  
  // Document state (NOT PERSISTED - fresh on each session)
  documents: Map<string, DocumentState>;
  activeDocument: DocumentState | null;
  
  // View cache (NOT PERSISTED - memory only)
  viewCache: Map<string, ViewState>;
  centerViewType: 'document' | 'folder' | 'channel' | 'ai' | 'settings';
  
  // Loading states
  isNavigating: boolean;
  rehydrated: boolean;
  
  // Methods
  setRehydrated: () => void;
  setActiveDriveId: (driveId: string | null) => void;
  navigateToPage: (pageId: string, pushToHistory?: boolean) => Promise<void>;
  saveCurrentView: () => void;
  restoreView: (pageId: string) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarOpen: (open: boolean) => void;
  setRightSidebarOpen: (open: boolean) => void;
  setTreeExpanded: (nodeId: string, expanded: boolean) => void;
  setTreeScrollPosition: (position: number) => void;
  updateDocument: (pageId: string, updates: Partial<DocumentState>) => void;
  clearCache: () => void;
  hydrateFromUrl: (url: string) => void;
}

// Utility functions
const layoutLogger = createClientLogger({ namespace: 'ui', component: 'layout-store' });

const extractPageId = (url: string): string | null => {
  layoutLogger.debug('extractPageId invoked', { urlType: typeof url });

  if (!url || typeof url !== 'string') {
    layoutLogger.error('extractPageId received invalid URL parameter', {
      url,
      urlType: typeof url,
    });
    return null;
  }

  try {
    const match = url.match(/\/dashboard\/[^\/]+\/([^\/\?#]+)/);
    layoutLogger.debug('extractPageId regex evaluated', {
      matchFound: Boolean(match),
    });
    return match ? match[1] : null;
  } catch (error) {
    layoutLogger.error('extractPageId failed to evaluate regex', {
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
};

const extractDriveId = (url: string): string | null => {
  layoutLogger.debug('extractDriveId invoked', { urlType: typeof url });

  if (!url || typeof url !== 'string') {
    layoutLogger.error('extractDriveId received invalid URL parameter', {
      url,
      urlType: typeof url,
    });
    return null;
  }

  try {
    const match = url.match(/\/dashboard\/([^\/\?#]+)/);
    layoutLogger.debug('extractDriveId regex evaluated', {
      matchFound: Boolean(match),
    });
    return match ? match[1] : null;
  } catch (error) {
    layoutLogger.error('extractDriveId failed to evaluate regex', {
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
};

const getViewType = (pageType: string): ViewState['viewType'] => {
  // Use centralized config for layout view type
  return getLayoutViewType(pageType as PageType) as ViewState['viewType'];
};

const fetchPage = async (pageId: string) => {
  const response = await fetchWithAuth(`/api/pages/${pageId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch page ${pageId}: ${response.status}`);
  }
  return response.json();
};

const MAX_CACHE_SIZE = 20;
const MAX_HISTORY_SIZE = 50;

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      // Initial state
      activePageId: null,
      activeDriveId: null,
      navigationHistory: [],
      leftSidebarOpen: true,
      rightSidebarOpen: false,
      treeExpanded: new Set(),
      treeScrollPosition: 0,
      documents: new Map(),
      activeDocument: null,
      viewCache: new Map(),
      centerViewType: 'document',
      isNavigating: false,
      rehydrated: false,
      
      setRehydrated: () => {
        set({ rehydrated: true });
      },

      setActiveDriveId: (driveId) => {
        set({ activeDriveId: driveId });
      },
      
      navigateToPage: async (pageId: string, pushToHistory = true) => {
        const state = get();
        
        if (state.activePageId === pageId) {
          return; // Already on this page
        }
        
        set({ isNavigating: true });
        
        try {
          // Save current view state before navigation (non-blocking)
          if (state.activePageId) {
            state.saveCurrentView();
            
            // Save dirty documents in background
            const currentDoc = state.activeDocument;
            if (currentDoc?.isDirty) {
              // Don't await - save in background
              saveDocumentToServer(currentDoc).catch(error => {
                layoutLogger.error('Background save failed during navigation', {
                  pageId: currentDoc.id,
                  error: error instanceof Error ? error : String(error),
                });
              });
            }
          }
          
          // Immediately set the new page ID for instant navigation feedback
          set({
            activePageId: pageId,
            isNavigating: false
          });
          
          // Update browser history immediately
          if (pushToHistory && state.activeDriveId) {
            const url = `/dashboard/${state.activeDriveId}/${pageId}`;
            window.history.pushState({ pageId }, '', url);
          }
          
          // Update navigation history
          const newHistory = [...state.navigationHistory, pageId].slice(-MAX_HISTORY_SIZE);
          set({ navigationHistory: newHistory });
          
          // Check cache first
          const cached = state.viewCache.get(pageId);
          if (cached) {
            set({
              centerViewType: cached.viewType,
              activeDocument: cached.document,
            });
            return;
          }
          
          // Lazy load page data in background - don't block navigation
          fetchPage(pageId).then(page => {
            if (!page) return;
            
            const viewType = getViewType(page.type);
            let document: DocumentState | null = null;
            
            if (viewType === 'document') {
              document = {
                id: pageId,
                content: page.content || '',
                isDirty: false,
                version: 0,
                lastSaved: Date.now()
              };
              
              // Add to documents map
              const currentState = get();
              const newDocuments = new Map(currentState.documents);
              newDocuments.set(pageId, document);
              set({ documents: newDocuments });
            }
            
            // Only update if we're still on the same page
            if (get().activePageId === pageId) {
              set({
                centerViewType: viewType,
                activeDocument: document,
              });
            }
          }).catch(error => {
            layoutLogger.error('Failed to load page data in background', {
              pageId,
              error: error instanceof Error ? error : String(error),
            });
            // Show error but don't revert navigation
            toast.error('Failed to load page content', {
              description: 'Content will load when available'
            });
          });

        } catch (error) {
          layoutLogger.error('Navigation failed', {
            pageId,
            error: error instanceof Error ? error : String(error),
          });
          toast.error('Failed to navigate to page', {
            description: error instanceof Error ? error.message : 'Unknown error'
          });
          
          set({ isNavigating: false });
          
          // Revert to previous page if navigation fails
          if (state.navigationHistory.length > 1) {
            const previousPageId = state.navigationHistory[state.navigationHistory.length - 2];
            set({ activePageId: previousPageId });
          }
        }
      },
      
      saveCurrentView: () => {
        const state = get();
        if (!state.activePageId) return;
        
        // Implement LRU eviction
        if (state.viewCache.size >= MAX_CACHE_SIZE) {
          const firstKey = state.viewCache.keys().next().value;
          if (firstKey) {
            state.viewCache.delete(firstKey);
          }
        }
        
        const viewState: ViewState = {
          viewType: state.centerViewType,
          document: state.activeDocument,
          scrollPosition: window.scrollY,
          timestamp: Date.now()
        };
        
        const newCache = new Map(state.viewCache);
        newCache.set(state.activePageId, viewState);
        set({ viewCache: newCache });
      },
      
      restoreView: (pageId: string) => {
        const state = get();
        const cached = state.viewCache.get(pageId);
        
        if (cached) {
          set({
            activePageId: pageId,
            centerViewType: cached.viewType,
            activeDocument: cached.document
          });
          
          // Restore scroll position
          setTimeout(() => {
            window.scrollTo(0, cached.scrollPosition);
          }, 0);
        }
      },
      
      toggleLeftSidebar: () => {
        set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen }));
      },

      toggleRightSidebar: () => {
        set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen }));
      },

      setLeftSidebarOpen: (open: boolean) => {
        set({ leftSidebarOpen: open });
      },

      setRightSidebarOpen: (open: boolean) => {
        set({ rightSidebarOpen: open });
      },
      
      setTreeExpanded: (nodeId: string, expanded: boolean) => {
        set((state) => {
          const newExpanded = new Set(state.treeExpanded);
          if (expanded) {
            newExpanded.add(nodeId);
          } else {
            newExpanded.delete(nodeId);
          }
          return { treeExpanded: newExpanded };
        });
      },
      
      setTreeScrollPosition: (position: number) => {
        set({ treeScrollPosition: position });
      },
      
      updateDocument: (pageId: string, updates: Partial<DocumentState>) => {
        const state = get();
        const existing = state.documents.get(pageId);
        
        if (existing) {
          const updated = { ...existing, ...updates };
          const newDocuments = new Map(state.documents);
          newDocuments.set(pageId, updated);
          
          // Only update if something actually changed
          const hasChanged = Object.keys(updates).some(key => 
            existing[key as keyof DocumentState] !== updates[key as keyof DocumentState]
          );
          
          if (hasChanged) {
            set({
              documents: newDocuments,
              activeDocument: state.activePageId === pageId ? updated : state.activeDocument
            });
          }
        }
      },
      
      clearCache: () => {
        set({
          viewCache: new Map(),
          documents: new Map(),
          activeDocument: null
        });
      },
      
      hydrateFromUrl: (url: string) => {
        const pageId = extractPageId(url);
        const driveId = extractDriveId(url);
        
        set({
          activePageId: pageId,
          activeDriveId: driveId
        });
        
        if (pageId) {
          // Navigate without pushing to history (we're already at this URL)
          get().navigateToPage(pageId, false);
        }
      }
    }),
    {
      name: 'layout-storage',
      // Selective persistence - only UI state
      partialize: (state) => ({
        leftSidebarOpen: state.leftSidebarOpen,
        rightSidebarOpen: state.rightSidebarOpen,
        treeExpanded: Array.from(state.treeExpanded),
        treeScrollPosition: state.treeScrollPosition
      }),
      // Custom merge function to handle Set conversion
      onRehydrateStorage: () => (state) => {
        state?.setRehydrated();
      },
      merge: (persistedState, currentState) => {
        return {
          ...currentState,
          ...(persistedState || {}),
          treeExpanded: new Set((persistedState as { treeExpanded?: string[] })?.treeExpanded || []),
        };
      }
    }
  )
);

// Helper function to save document to server
async function saveDocumentToServer(document: DocumentState): Promise<void> {
  try {
    await patch(`/api/pages/${document.id}`, {
      content: document.content,
      version: document.version
    });
    
    // Update document state
    useLayoutStore.getState().updateDocument(document.id, {
      isDirty: false,
      lastSaved: Date.now()
    });
    
    toast.success('Page saved successfully!');
  } catch (error) {
    layoutLogger.error('Failed to save document to server', {
      pageId: document.id,
      error: error instanceof Error ? error : String(error),
    });
    toast.error('Failed to save page content');
    throw error;
  }
}
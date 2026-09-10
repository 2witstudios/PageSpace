import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Drive } from '@pagespace/lib/types';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
export type { Drive };

interface DriveState {
  drives: Drive[];
  currentDriveId: string | null;
  isLoading: boolean;
  lastFetched: number;
  fetchDrives: (includeTrash?: boolean, forceRefresh?: boolean) => Promise<void>;
  addDrive: (drive: Drive) => void;
  removeDrive: (driveId: string) => void;
  updateDrive: (driveId: string, updates: Partial<Drive>) => void;
  setCurrentDrive: (driveId: string | null) => void;
  reset: () => void;
}

const CACHE_DURATION = 5 * 60 * 1000;

/**
 * The drives request in flight, if any, and its shape. Several controls ask
 * on the same mount; a narrower ask awaits this one instead of starting
 * another, so `await fetchDrives()` never resolves before the store has
 * drives (the voice trigger reads the store right after awaiting).
 */
let inFlight: Promise<void> | null = null;
let inFlightIncludesTrash = false;
/** Only the newest request may write: an older, narrower response must not overwrite a trash-inclusive one. */
let latestRequestId = 0; // 5 minutes

export const useDriveStore = create<DriveState>()(
  persist(
    (set, get) => ({
      drives: [],
      currentDriveId: null,
      isLoading: false,
      lastFetched: 0,
      fetchDrives: async (includeTrash = false, forceRefresh = false) => {
        const state = get();
        const now = Date.now();
        
        // Skip fetch if recently fetched and we have data (unless force refresh)
        if (!forceRefresh && state.drives.length > 0 && (now - state.lastFetched) < CACHE_DURATION) {
          return;
        }
        // Several controls ask on the same mount (sidebar, crumb, a page's
        // focus line); one request serves them all — unless the new ask is
        // broader (trash included) than the one in flight.
        if (!forceRefresh && inFlight && (inFlightIncludesTrash || !includeTrash)) {
          return inFlight;
        }
        inFlightIncludesTrash = includeTrash;
        const requestId = ++latestRequestId;

        set({ isLoading: true });
        inFlight = (async () => {
          try {
            const url = includeTrash ? '/api/drives?includeTrash=true' : '/api/drives';
            const response = await fetchWithAuth(url);
            if (!response.ok) {
              throw new Error('Failed to fetch drives');
            }
            const drives = await response.json();
            if (requestId === latestRequestId) {
              set({ drives, isLoading: false, lastFetched: now });
            }
          } catch (error) {
            console.error(error);
            if (requestId === latestRequestId) {
              set({ isLoading: false });
            }
          }
        })();
        const request = inFlight;
        void request.finally(() => {
          if (inFlight === request) inFlight = null;
        });
        return request;
      },
      addDrive: (drive: Drive) => set((state) => ({
        drives: [...state.drives, drive],
        lastFetched: Date.now()
      })),
      removeDrive: (driveId: string) => set((state) => ({
        drives: state.drives.filter(d => d.id !== driveId),
        lastFetched: Date.now()
      })),
      updateDrive: (driveId: string, updates: Partial<Drive>) => set((state) => ({
        drives: state.drives.map(d => d.id === driveId ? { ...d, ...updates } : d),
        lastFetched: Date.now()
      })),
      setCurrentDrive: (driveId: string | null) => set({ currentDriveId: driveId }),
      reset: () => set({ drives: [], lastFetched: 0, currentDriveId: null, isLoading: false }),
    }),
    {
      name: 'drive-storage',
      partialize: (state) => ({
        drives: state.drives,
        lastFetched: state.lastFetched,
        currentDriveId: state.currentDriveId,
      }),
    }
  )
);
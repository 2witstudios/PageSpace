import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Drive } from '@pagespace/lib/client';
export type { Drive };

interface DriveState {
  drives: Drive[];
  currentDriveId: string | null;
  isLoading: boolean;
  lastFetched: number;
  fetchDrives: () => Promise<void>;
  addDrive: (drive: Drive) => void;
  setCurrentDrive: (driveId: string | null) => void;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useDriveStore = create<DriveState>()(
  persist(
    (set, get) => ({
      drives: [],
      currentDriveId: null,
      isLoading: false,
      lastFetched: 0,
      fetchDrives: async () => {
        const state = get();
        const now = Date.now();
        
        // Skip fetch if recently fetched and we have data
        if (state.drives.length > 0 && (now - state.lastFetched) < CACHE_DURATION) {
          return;
        }
        
        set({ isLoading: true });
        try {
          const response = await fetch('/api/drives', {
            credentials: 'include',
          });
          if (!response.ok) {
            throw new Error('Failed to fetch drives');
          }
          const drives = await response.json();
          set({ drives, isLoading: false, lastFetched: now });
        } catch (error) {
          console.error(error);
          set({ isLoading: false });
        }
      },
      addDrive: (drive: Drive) => set((state) => ({ 
        drives: [...state.drives, drive],
        lastFetched: Date.now() // Reset cache when adding new drive
      })),
      setCurrentDrive: (driveId: string | null) => set({ currentDriveId: driveId }),
    }),
    {
      name: 'drive-storage',
      partialize: (state) => ({
        drives: state.drives,
        lastFetched: state.lastFetched,
      }),
    }
  )
);
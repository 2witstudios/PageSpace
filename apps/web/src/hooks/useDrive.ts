import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Drive } from '@pagespace/lib/client';
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
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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
        
        set({ isLoading: true });
        try {
          const url = includeTrash ? '/api/drives?includeTrash=true' : '/api/drives';
          const response = await fetchWithAuth(url);
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
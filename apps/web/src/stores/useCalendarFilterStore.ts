import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CalendarFilterState {
  hiddenCalendars: string[];
  toggleCalendar: (key: string) => void;
  showAll: () => void;
  hideAll: (keys: string[]) => void;
  isVisible: (key: string) => boolean;
}

export const useCalendarFilterStore = create<CalendarFilterState>()(
  persist(
    (set, get) => ({
      hiddenCalendars: [],

      toggleCalendar: (key: string) => {
        const { hiddenCalendars } = get();
        if (hiddenCalendars.includes(key)) {
          set({ hiddenCalendars: hiddenCalendars.filter((k) => k !== key) });
        } else {
          set({ hiddenCalendars: [...hiddenCalendars, key] });
        }
      },

      showAll: () => set({ hiddenCalendars: [] }),

      hideAll: (keys: string[]) => set({ hiddenCalendars: [...keys] }),

      isVisible: (key: string) => !get().hiddenCalendars.includes(key),
    }),
    {
      name: 'calendar-filter-storage',
      partialize: (state) => ({
        hiddenCalendars: state.hiddenCalendars,
      }),
    }
  )
);

import { create } from 'zustand';

/** Whether the in-middle settings sub-nav is open. One flag for every settings area (IMC-3.12). */
export type SettingsSubnavState = {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
};

export const useSettingsSubnavStore = create<SettingsSubnavState>()((set) => ({
  open: true,
  setOpen: (open) => set({ open }),
}));

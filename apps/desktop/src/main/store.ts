import Store from 'electron-store';

export interface StoreSchema {
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  appUrl?: string;
  minimizeToTray?: boolean;
}

export const store = new Store<StoreSchema>({
  defaults: {
    windowBounds: { width: 1024, height: 700 },
    minimizeToTray: true,
  },
}) as unknown as Store<StoreSchema>;

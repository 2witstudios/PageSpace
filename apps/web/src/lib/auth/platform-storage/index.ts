import type { PlatformStorage } from './types';
import { isCapacitorApp, getPlatform } from '@/lib/capacitor-bridge';

export * from './types';

let instance: PlatformStorage | null = null;

export function getPlatformStorage(): PlatformStorage {
  if (instance) return instance;

  if (typeof window !== 'undefined') {
    if (window.electron?.isDesktop) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DesktopStorage } = require('./desktop-storage');
      instance = new DesktopStorage();
    } else if (isCapacitorApp() && getPlatform() === 'ios') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { IOSStorage } = require('./ios-storage');
      instance = new IOSStorage();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WebStorage } = require('./web-storage');
      instance = new WebStorage();
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebStorage } = require('./web-storage');
    instance = new WebStorage();
  }

  if (!instance) {
    throw new Error('Failed to initialize platform storage');
  }

  console.log(`[PlatformStorage] ${instance.platform}`);
  return instance;
}

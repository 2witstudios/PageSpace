import { registerPlugin } from '@capacitor/core';

export interface PageSpaceKeychainPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<{ success: boolean }>;
  remove(options: { key: string }): Promise<{ success: boolean }>;
}

export const PageSpaceKeychain = registerPlugin<PageSpaceKeychainPlugin>('PageSpaceKeychain');

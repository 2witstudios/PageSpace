import { BrowserWindow, Tray } from 'electron';
import type { StoredAuthSession } from './auth-storage';

export let mainWindow: BrowserWindow | null = null;
export let tray: Tray | null = null;
export let isQuitting = false;
export let isSuspended = false;
export let suspendTime: number | null = null;
export let cachedMachineId: string | null = null;
export let cachedSession: StoredAuthSession | null | undefined = undefined;

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

export function setTray(newTray: Tray | null): void {
  tray = newTray;
}

export function setIsQuitting(value: boolean): void {
  isQuitting = value;
}

export function setIsSuspended(value: boolean): void {
  isSuspended = value;
}

export function setSuspendTime(time: number | null): void {
  suspendTime = time;
}

export function setCachedMachineId(id: string | null): void {
  cachedMachineId = id;
}

export function setCachedSession(session: StoredAuthSession | null | undefined): void {
  cachedSession = session;
}

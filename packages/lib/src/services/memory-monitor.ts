// Stub: on Fly.io with multiple machines, per-process memory monitoring
// is meaningless. All upload decisions are made by the semaphore tier limits.

export interface MemoryStatus {
  totalMB: number;
  freeMB: number;
  usedMB: number;
  availableMB: number;
  percentUsed: number;
  canAcceptUpload: boolean;
  warningLevel: 'normal' | 'warning' | 'critical';
}

export interface ProcessMemoryInfo {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export async function getMemoryStatus(): Promise<MemoryStatus> {
  return {
    totalMB: 0,
    freeMB: 0,
    usedMB: 0,
    availableMB: 0,
    percentUsed: 0,
    canAcceptUpload: true,
    warningLevel: 'normal',
  };
}

export function getProcessMemory(): ProcessMemoryInfo {
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
}

export async function hasEnoughMemoryForUpload(_fileSize: number): Promise<boolean> {
  return true;
}

export async function checkMemoryMiddleware(): Promise<{
  allowed: boolean;
  reason?: string;
  status?: MemoryStatus;
}> {
  return { allowed: true };
}

export function setupMemoryProtection(_intervalMs?: number): NodeJS.Timeout {
  return setInterval(() => {}, 3600000);
}

export function formatMemory(mb: number): string {
  if (mb < 1024) return `${mb}MB`;
  return `${(mb / 1024).toFixed(2)}GB`;
}

export function emergencyMemoryCleanup(): void {
  // no-op
}

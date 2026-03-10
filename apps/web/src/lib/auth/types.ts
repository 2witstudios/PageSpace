export interface FetchOptions extends RequestInit {
  skipAuth?: boolean;
  maxRetries?: number;
}

export interface QueuedRequest {
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
  url: string;
  options?: FetchOptions;
}

export interface SessionRefreshResult {
  success: boolean;
  shouldLogout: boolean;
}

export interface SessionCache {
  token: string;
}

export interface PowerSuspendEvent {
  suspendTime: number;
}

export interface PowerResumeEvent {
  resumeTime: number;
  sleepDuration: number;
  forceRefresh: boolean;
}

export interface PowerUnlockEvent {
  shouldRefresh: boolean;
}

export interface PowerState {
  isSuspended: boolean;
  suspendTime: number | null;
}

export interface RefreshCooldownConfig {
  lastSuccessfulRefresh: number | null;
  cooldownMs: number;
}

export const SESSION_RETRY_DELAY_MS = 100;
export const TOKEN_RETRIEVAL_TIMEOUT_MS = 3000;
export const REFRESH_COOLDOWN_MS = 5000;

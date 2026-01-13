import type { EnforcedAuthContext } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      auth?: EnforcedAuthContext;
    }
  }
}

export {};
